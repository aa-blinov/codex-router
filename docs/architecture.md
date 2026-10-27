# Архитектура

## Компоненты

```
Codex CLI / Codex Desktop
        │  Responses API, SSE
        ▼
127.0.0.1:8788  codex-router.mjs
        ├── deepseek-*  → api.deepseek.com/chat/completions
        ├── minimax-*   → api.minimax.io/v1/chat/completions
        └── остальные   → chatgpt.com/backend-api/codex
```

Мост — один процесс Node без зависимостей. Внешнего состояния у него нет: конфиг и ключи читаются
при старте, журнал пишется построчно в `logs/routes.jsonl`.

## Почему один провайдер

В Codex `model_provider` глобальный: он один на приложение, а пикер меняет только имя модели.
Сопоставления «модель → провайдер» в Codex нет, поэтому выбор бэкенда вынесен в мост: он смотрит на
имя модели в теле запроса и решает, куда его отправить.

## Трансляция протоколов

Codex говорит на Responses API, DeepSeek и MiniMax — на Chat Completions.

**Запрос**

| Responses | Chat Completions |
|---|---|
| `instructions` | `system`-сообщение |
| `message.role = developer` | `system` |
| `function_call` в истории | `assistant.tool_calls` |
| `function_call_output` | `role: tool` |
| `custom_tool_call` | `assistant.tool_calls` с аргументом `{"input": "..."}` |
| `tools[].type = function` | как есть |
| `tools[].type = namespace` | вложенные функции разворачиваются в плоский список |
| `tools[].type = custom` | функция с единственным полем `input` |
| `tools[].type = web_search` | отбрасывается |
| `reasoning.effort` | `thinking` или `reasoning_effort`, зависит от провайдера |

**Ответ**: `chat.completion.chunk` → SSE Responses

```
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta …
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

Для инструментов — `response.function_call_arguments.*` или `response.custom_tool_call_input.*`.
Размышления провайдера (`reasoning_content`) идут отдельным элементом `reasoning` с событиями
`response.reasoning_summary_part.added`, `response.reasoning_summary_text.delta` и `...done`.

## Два дефекта протокола, которые пришлось закрыть

1. **Конфликт имён инструментов.** Разворот `namespace` давал дубли имён (например, `wait` дважды),
   OpenAI-совместимые API отвечают 400 «Tool names must be unique». Решение — дедупликация по имени.
2. **Порядок tool-сообщений.** Codex присылает `function_call`, затем свою текстовую реплику, и только
   потом результат инструмента. Chat Completions требует результат сразу после `tool_calls`.
   Решение — предварительный сбор результатов и вставка вплотную к вызову.

## Авторизация

- OpenAI: провайдер объявлен с `requires_openai_auth = true`, Codex сам прикладывает `Authorization`
  и `ChatGPT-Account-Id`. Мост их только пересылает и никогда не хранит.
- DeepSeek и MiniMax: ключ из `keys.dpapi` (DPAPI) или переменной окружения.

## Подстраховка при лимите

Если OpenAI отвечает `429`, `402` или `403`, мост повторяет тот же запрос в DeepSeek с моделью
`deepseek.fallbackModel`. В журнале такой случай помечен `fallback: deepseek`.

## Живучесть

`HKCU\...\Run` запускает `wscript supervise.vbs`, который держит мост скрыто и перезапускает его
при падении через 3 секунды. Планировщик задач не используется: создание задач требует прав
администратора, а автозапуск через `Run` — нет.
## Подсчёт токенов

Точного токенизатора для DeepSeek и MiniMax в мосте нет, а фиксированный коэффициент врёт на русском
тексте и коде. Поэтому мост калибруется сам: после каждого ответа берёт `usage.prompt_tokens`, делит
на длину запроса в символах и обновляет коэффициент `chars/token` по экспоненциальному сглаживанию.
Значения лежат в `token-calibration.json` рядом с мостом и видны в `/health` (`tokenizer`).

При ошибке переполнения контекста мост дополнительно использует числа из самого ответа API
(`limit` и `requested`) и режет историю пропорционально перелёту.
## Точный размер контекста

Источник правды — `usage.prompt_tokens` из ответа провайдера. Мост хранит последнее значение и длину
запроса, поэтому при следующем обращении проецирует размер: `lastPromptTokens × (новые_символы /
старые_символы)`. Если проекция превышает 90% лимита, история режется до 75% ещё до отправки —
в журнале это `proactiveTrim`. Накопительная статистика по моделям лежит в `usage-stats.json` и в
`/health` → `usage`.
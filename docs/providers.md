# Провайдеры

## Сводка

| id | Префикс модели | База | Ключ | Reasoning |
|---|---|---|---|---|
| `deepseek` | `deepseek-*` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` или хранилище | `thinking` |
| `minimax` | `minimax-*` | `https://api.minimax.io` | `MINIMAX_API_KEY` или хранилище | `reasoning_effort` |
| OpenAI | всё остальное | `https://chatgpt.com/backend-api/codex` | токен Codex | как просит Codex |

## DeepSeek

Модели API: `deepseek-flash`, `deepseek-v4-pro`. Остальные имена — алиасы моста:

| Алиас в Codex | Что уходит в API |
|---|---|
| `deepseek-v4.1-flash` | `deepseek-flash` |
| `deepseek-v4-flash` | `deepseek-flash` |
| `deepseek-flash` | `deepseek-flash` |
| `deepseek-v4-pro` | `deepseek-v4-pro` |
| `deepseek-pro` | `deepseek-v4-pro` |

Reasoning: `thinking: {type: enabled|disabled}`. Оба значения API принимает. Параметр
`reasoning_effort` DeepSeek молча игнорирует (даже недопустимые значения не вызывают ошибку).

Проверено: `thinking=enabled` → 200, `thinking=disabled` → 200, `reasoning_effort=ultra` → 200.

## MiniMax

Модели: `MiniMax-M3.1-Flash`, `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`,
`MiniMax-M2.1`, `MiniMax-M2`. В каталоге Codex опубликованы первые две.

### MiniMax-M3.1-Flash

- `reasoning_effort`: `low`, `medium`, `high`, `xhigh`, `max`.
- `none` запрещён: `requires adaptive thinking; reasoning effort none is not allowed` (400).
- `thinking.type = disabled` тоже 400.
- Мост переводит `none → low`, остальные уровни как есть.

### MiniMax-M3

- `thinking.type` принимает только `adaptive` и `disabled` (`enabled` → 400).
- Без `reasoning_split: true` размышления приходят прямо в `content` как `<think>…</think>`.
- `reasoning_effort`: `low`, `medium`, `high`, `xhigh`, `max`; `none` не падает, но и не отключает
  мышление.
- Мост использует режим `toggle+effort`: при `effort = none` отправляет `thinking: {type: disabled}`,
  иначе `reasoning_effort` плюс `reasoning_split: true`.
- В каталоге у M3 поэтому есть уровень `none`, у M3.1-Flash его нет.

## Как добавить провайдера

1. Добавить запись в `DEFAULTS.providers` в `src/codex-router.mjs`: `baseUrl`, `match`, `keyEnv`,
   `modelMap`, `defaultModel`, `reasoning`.
2. Если у провайдера нестандартный контракт reasoning — добавить ветку в `toChatRequest` или
   per-model запись в `modelReasoning`.
3. Добавить запись модели в `New-CatalogEntry` в `scripts/codex-router.ps1`.
4. Описать контракт здесь, с результатами реальных проверок.
5. Для ключа — расширить `ValidateSet` у параметра `-Provider`.

### Inline-вызовы инструментов

Иногда MiniMax вместо 	ool_calls присылает вызов обычным текстом:

`
<]minimax[>[<invoke name="exec_command">]<]minimax[>[<cmd>git status]<]minimax[>[<workdir>E:\work]
`

Без обработки такой блок попадал в ответ Codex как текст, и инструмент не выполнялся. Мост
распознаёт маркер <]minimax[>[, собирает параметры и отдаёт нормальный unction_call
(или custom_tool_call для freeform-инструментов). Маркеры в текст ответа не попадают; если
разобрать блок не удалось, они просто вырезаются.
## Изображения

Все три модели принимают изображения через OpenAI-совместимый `image_url`:

| Модель | Проверка |
|---|---|
| `deepseek-v4.1-flash` | синий квадрат → `Blue` |
| `MiniMax-M3.1-Flash` | синий квадрат → `Blue`, зелёный/красный — тоже верно |
| `MiniMax-M3` | синий квадрат → `Blue` |

Мост переводит части `input_image` из Responses в `image_url`, а каталог помечает модели как
`input_modalities: ["text", "image"]` — без этого Codex отказывается прикреплять картинки.
## Reasoning в истории

DeepSeek в thinking-режиме требует, чтобы assistant-сообщения с `tool_calls` возвращались вместе с
`reasoning_content`. Без него API отвечает 400:

> The `reasoning_content` in the thinking mode must be passed back to the API.

Мост запоминает reasoning каждого хода по `call_id` (до 500 записей) и подставляет его при сборке
истории. Если провайдер почему-то не прислал reasoning для хода, такой запрос уходит с
`thinking: {type: disabled}`, чтобы не ломать цепочку инструментов.
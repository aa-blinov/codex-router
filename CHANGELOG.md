# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии по
[SemVer](https://semver.org/lang/ru/).

## [1.2.3] — 2026-10-27

### Fixed

- DeepSeek в thinking-режиме отвергал историю с сообщением `The easoning_content in the thinking mode must be passed back`.
  Теперь мост запоминает reasoning каждого хода по `call_id` и возвращает его в assistant-сообщениях с `tool_calls`.
- Если провайдер не прислал reasoning для хода, запрос уходит с `thinking: disabled` вместо пустого поля.
## [1.2.2] — 2026-10-27

### Added

- Поддержка изображений: части `input_image` из Responses переводятся в `image_url` для Chat Completions.
- Каталог объявляет `deepseek-v4.1-flash`, `minimax-m3.1-flash` и `minimax-m3` мультимодальными.

### Fixed

- Codex отказывался прикреплять изображения: «Эта модель не поддерживает изображения».
## [1.2.1] — 2026-10-27

### Fixed

- MiniMax иногда присылает вызов инструмента обычным текстом в формате
  `<]minimax[>[<invoke name="...">]<]minimax[>[<param>value`. Мост теперь распознаёт такие блоки,
  превращает их в `function_call`/`custom_tool_call` и не пропускает маркеры в ответ Codex.

### Added

- Тест на inline-формат вызова (всего 19 проверок).
## [1.2.0] — 2026-10-26

### Added

- Провайдер MiniMax (`api.minimax.io/v1`), маршрут по префиксу `minimax-*`.
- Уровни reasoning для MiniMax: `low`, `medium`, `high`, `xhigh`, `max`; `none` запрещён API.
- Отдельный режим reasoning для `MiniMax-M3`: `toggle+effort` с `reasoning_split`, уровень `none`.
- Общее DPAPI-хранилище ключей `keys.dpapi` для нескольких провайдеров.
- Логирование фактического reasoning, отправленного в API.
- Автоматический переход в DeepSeek при лимите OpenAI (429/402/403).

### Changed

- Каталог моделей собирается из шаблона `templates/model-template.json`.
- Репозиторий приведён к стандартной структуре: `src/`, `docs/`, `tests/`, `.github/`.

## [1.1.0] — 2026-10-26

### Added

- Собственный мост `codex-router.mjs`: трансляция Responses ↔ Chat Completions для DeepSeek.
- Проброс в ChatGPT-бэкенд с авторизацией, которую подставляет Codex.
- DPAPI-шифрование ключа, ACL на файл, перенос ключа из стороннего моста.

### Fixed

- Конфликт имён инструментов после разворота `namespace`-тулов.
- Порядок «tool-сообщение сразу после tool_calls».

## [1.0.0] — 2026-10-26

### Added

- Провайдер `codex_router` и каталог моделей OpenAI + DeepSeek.
- Автозапуск через `HKCU\...\Run` и VBS-супервизор.
- CLI `codex-router.ps1`: install, key, start, stop, restart, status, logs, uninstall.

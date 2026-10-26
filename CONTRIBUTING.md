# Contributing

## Структура

```
src/        мост (Node, ESM, без зависимостей)
scripts/    CLI и супервизор (PowerShell + VBS)
templates/  шаблон описания модели для каталога Codex
docs/       подробности: архитектура, провайдеры, настройка, отладка
tests/      дымовые тесты без сети
```

## Перед коммитом

```powershell
node --check src/codex-router.mjs
node tests/smoke.mjs
```

Тест поднимает фальшивый Chat-Completions сервер и проверяет трансляцию, поэтому не тратит токены
и не требует ключей.

## Правила

- Никаких секретов в коде, тестах, логах и коммитах.
- Ключи в репозиторий не попадают: они живут в `%USERPROFILE%\.codex\codex-router\keys.dpapi`.
- Новый провайдер добавляется в `DEFAULTS.providers` в `src/codex-router.mjs` и в CLI
  (`New-CatalogEntry`), плюс запись в `docs/providers.md`.
- Контракт reasoning провайдера фиксируется в `docs/providers.md` со ссылкой на реальную проверку.
- Ломающие изменения — через мажорную версию в `CHANGELOG.md`.

## Проверка перед PR

1. `node tests/smoke.mjs` — зелёный.
2. `.\scripts\codex-router.ps1 install -Force` — установка проходит.
3. `.\scripts\codex-router.ps1 status` — мост живой, ключи на месте.
4. Один реальный вызов через Codex на каждый затронутый провайдер.

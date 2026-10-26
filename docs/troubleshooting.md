# Отладка

## Быстрая диагностика

```powershell
.\scripts\codex-router.ps1 status
Invoke-WebRequest http://127.0.0.1:8788/health | Select-Object -Expand Content
codex doctor
```

## Симптомы и причины

### Codex пишет «stream disconnected before completion»

Мост вернул `response.failed` с текстом ошибки провайдера. Смотрите `logs/routes.jsonl`: поле
`error` содержит начало ответа API.

### `Tool names must be unique`

Дубли имён инструментов после разворота `namespace`. В мосте дедупликация уже есть; ошибка означает,
что имя инструмента пришло дважды из разных источников и дедупликация не сработала — проверьте
`convertTools`.

### `assistant message with tool_calls must be followed by tool messages`

Нарушен порядок истории: результат инструмента оказался не сразу после `tool_calls`. Мост
переупорядочивает историю; если ошибка вернулась, значит в запросе есть вызов без результата.

### `failed to parse model_catalog_json … missing field supported_reasoning_levels`

Каталог собран неполным. Пересоберите: `.\scripts\codex-router.ps1 install -Force`. Шаблон лежит в
`templates/model-template.json`.

### `no API key for …`

Ключ не найден ни в `keys.dpapi`, ни в переменной окружения. Проверьте:

```powershell
.\scripts\codex-router.ps1 key
```

### `Не удалось прочитать хранилище ключей`

Файл `keys.dpapi` создан другим пользователем или повреждён. Перевыпустите ключ:

```powershell
.\scripts\codex-router.ps1 key -Provider deepseek -Key <ключ>
```

### Порт занят

```powershell
Get-NetTCPConnection -LocalPort 8788 -State Listen
.\scripts\codex-router.ps1 restart
```

### Codex не видит модели

Перезапустите приложение: каталог читается на старте. Проверьте, что в `config.toml` стоит
`model_provider = "codex_router"` и путь к `models.mixed.json` существует.

### Всё отвечает, но модель не та

В пикере есть пункт «По умолчанию / Рекомендуемый набор моделей» — это пресет приложения, он может
подставить свой дефолт. Выбирайте конкретную строку модели.

## Полезное

```powershell
# что уходит в API по reasoning
(Invoke-WebRequest 'http://127.0.0.1:8788/router/log?limit=5').Content

# живой процесс и порт
Get-NetTCPConnection -LocalPort 8788 -State Listen | Select-Object OwningProcess
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object CommandLine -like '*supervise*'
```
## Linux

### `EADDRINUSE` в WSL

WSL2 в режиме зеркальной сети делит `127.0.0.1` с Windows. Если мост уже запущен на Windows, порт
`8788` внутри WSL занят его же процессом. Для теста задайте другой порт:

```bash
PORT=18788 ./scripts/linux/install.sh install
```

### Служба не стартует

```bash
systemctl --user status codex-router
journalctl --user -u codex-router -n 50 --no-pager
```

Если `systemctl --user` недоступен, установщик использует `nohup`; тогда смотрите
`~/.codex/codex-router/logs/router.out.log`.

### Права на ключи

```bash
stat -c '%a %n' ~/.codex/codex-router/keys.json   # ожидается 600
```
# Настройка

## Файлы

| Путь | Назначение |
|---|---|
| `%USERPROFILE%\.codex\codex-router\codex-router.mjs` | мост |
| `%USERPROFILE%\.codex\codex-router\codex-router.config.json` | порт и переопределения провайдеров |
| `%USERPROFILE%\.codex\codex-router\keys.dpapi` | ключи (DPAPI, JSON внутри) |
| `%USERPROFILE%\.codex\codex-router\node-path.txt` | путь к node.exe для супервизора |
| `%USERPROFILE%\.codex\codex-router\logs\routes.jsonl` | журнал маршрутов |
| `%USERPROFILE%\.codex\codex-router\logs\router.err.log` | ошибки процесса |
| `%USERPROFILE%\.codex\models.mixed.json` | каталог моделей Codex |
| `%USERPROFILE%\.codex\config.toml` | провайдер `codex_router` |
| `HKCU\...\Run\CodexRouter` | автозапуск |

## codex-router.config.json

Файл необязательный: без него работают значения по умолчанию. Пример с переопределениями:

```json
{
  "port": 8788,
  "providers": {
    "deepseek": { "fallbackModel": "deepseek-v4.1-flash" },
    "minimax": { "modelMap": { "minimax-m3.1-flash": "MiniMax-M3.1-Flash" } }
  }
}
```

Ключи провайдеров здесь не хранятся. Для ключей — `keys.dpapi` или переменные окружения.

## Переменные окружения

| Переменная | Действие |
|---|---|
| `DEEPSEEK_API_KEY` | перекрывает ключ DeepSeek из хранилища |
| `MINIMAX_API_KEY` | перекрывает ключ MiniMax |
| `ROUTER_DUMP` | при `1` последний входящий и исходящий запросы пишутся в `logs/last-*.json` |

## CLI

```powershell
.\scripts\codex-router.ps1 install [-Force]     # установка: файлы, ключи, каталог, конфиг, автозапуск
.\scripts\codex-router.ps1 key                  # маски ключей
.\scripts\codex-router.ps1 key -Provider minimax -Key sk-...
.\scripts\codex-router.ps1 key -Force           # показать ключи открытым текстом
.\scripts\codex-router.ps1 status               # провайдеры, ключи, модель-карта, маршруты
.\scripts\codex-router.ps1 start | stop | restart
.\scripts\codex-router.ps1 logs
.\scripts\codex-router.ps1 uninstall
```

## HTTP-эндпоинты моста

| Путь | Назначение |
|---|---|
| `POST /v1/responses` | основная точка для Codex |
| `GET /v1/models` | список алиасов провайдеров |
| `GET /health` | порт, провайдеры, наличие ключа и его источник, карта моделей |
| `GET /router/log?limit=50` | журнал маршрутов |

Тела запросов и ответов не логируются. Строка журнала: время, модель, upstream-модель, цель,
источник ключа, отправленный reasoning, статус, миллисекунды; при ошибке — начало ответа API.

## Порт

Меняется параметром `-Port` при установке и полем `port` в конфиге. После смены порта нужно заново
выполнить `install`, чтобы обновить `base_url` провайдера в `config.toml`.

## Каталог моделей

Собирается из `%USERPROFILE%\.codex\models_cache.json` (модели аккаунта OpenAI) плюс записи из шаблона
`templates/model-template.json`. Codex валидирует поля модели, поэтому шаблон должен оставаться полным:
недостающее поле ломает загрузку конфига.

## Linux и macOS

Пути те же (`~/.codex/...`), отличия только в хранении ключей и автозапуске.

| Что | Windows | Linux / macOS |
|---|---|---|
| Ключи | `keys.dpapi` (DPAPI) | `keys.json` (права `0600`) |
| Автозапуск | `HKCU\...\Run` + VBS-супервизор | systemd `--user`, `Restart=always` |
| Логи | `logs\router.err.log` | `journalctl --user -u codex-router` |
| CLI | `scripts\windows\codex-router.ps1` | `scripts/linux/install.sh` |

Если systemd недоступен (контейнер, старый WSL), `install.sh` поднимает мост через `nohup` и хранит
pid в `logs/../router.pid`.

Порт по умолчанию тот же — `8788`. В WSL с зеркальной сетью `127.0.0.1` общий с Windows, поэтому для
параллельного теста задайте другой порт: `PORT=18788 ./scripts/linux/install.sh install`.
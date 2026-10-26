# Codex Router

[![CI](https://github.com/aa-blinov/codex-router/actions/workflows/ci.yml/badge.svg)](https://github.com/aa-blinov/codex-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey.svg)](README.md)

Локальный мост, который даёт Codex сразу три бэкенда: OpenAI, DeepSeek и MiniMax. Модель
выбирается в обычном пикере Codex, а мост по её имени решает, куда отправить запрос.

Зачем это нужно: Codex умеет держать только одного провайдера на приложение. Если прописать
DeepSeek, пропадают модели OpenAI; если оставить OpenAI, DeepSeek недоступен. Мост снимает это
ограничение — Codex видит один провайдер `codex_router`, за которым стоят все три.

```
Codex CLI / Desktop
        │  model: gpt-6.1-sol | deepseek-v4.1-flash | minimax-m3.1-flash
        ▼
127.0.0.1:8788  Codex Router
        ├── deepseek-*  → DeepSeek
        ├── minimax-*   → MiniMax
        └── остальные   → OpenAI (ChatGPT-бэкенд)
```

Работает на Windows, Linux и macOS. Зависимостей нет: нужен только Node.js 18+.

## Быстрый старт — Windows

Требуется установленный Codex, в который вы уже вошли.

```powershell
git clone https://github.com/aa-blinov/codex-router.git
cd codex-router

.\scripts\windows\codex-router.ps1 install -Force
.\scripts\windows\codex-router.ps1 key -Provider minimax -Key sk-...
```

## Быстрый старт — Linux и WSL

```bash
git clone https://github.com/aa-blinov/codex-router.git
cd codex-router

./scripts/linux/install.sh install --deepseek-key sk-... --minimax-key sk-...
./scripts/linux/install.sh status
```

Ставится systemd-служба `--user` с автоперезапуском. Если systemd недоступен, мост поднимается
через `nohup`. Проверено в WSL Ubuntu 24.04: установка, служба, ключи и дымовые тесты проходят.

После установки перезапустите Codex. В пикере появятся `DeepSeek-V4.1-Flash`, `MiniMax-M3.1-Flash`
и `MiniMax-M3` рядом с обычными моделями OpenAI.

Проверка:

```powershell
codex exec --skip-git-repo-check "Reply with the single word OK."
codex exec -c model="minimax-m3.1-flash" --skip-git-repo-check "Reply with the single word OK."
```

## Что нужно знать

- **Ключи не лежат открытым текстом.** Windows: `keys.dpapi` под DPAPI текущего пользователя.
  Linux/macOS: `keys.json` с правами `0600`. В обоих случаях — ACL только для владельца.
  Переменные `DEEPSEEK_API_KEY` / `MINIMAX_API_KEY` имеют приоритет, если заданы.
- **OpenAI работает без настройки ключа.** Codex сам прикладывает токен ChatGPT, мост его только
  пересылает.
- **Автозапуск без администратора.** Windows: `HKCU\...\Run` плюс скрытый супервизор. Linux:
  systemd `--user` с `Restart=always`.
- **Лимит OpenAI не ломает работу.** При 429/402/403 запрос автоматически повторяется в DeepSeek.

## Провайдеры

| Провайдер | Модели в каталоге | Reasoning |
|---|---|---|
| OpenAI | все модели вашего аккаунта | как просит Codex |
| DeepSeek | `DeepSeek-V4.1-Flash` | `thinking` включён/выключен |
| MiniMax | `MiniMax-M3.1-Flash`, `MiniMax-M3` | `low`…`max`, у M3 есть `none` |

Различия контрактов, включая M3 против M3.1-Flash, разобраны в [docs/providers.md](docs/providers.md).

## Команды

Windows:

```powershell
.\scripts\windows\codex-router.ps1 install [-Force]
.\scripts\windows\codex-router.ps1 status
.\scripts\windows\codex-router.ps1 key [-Provider minimax -Key sk-...]
.\scripts\windows\codex-router.ps1 start | stop | restart | logs | uninstall
```

Linux/macOS:

```bash
./scripts/linux/install.sh install [--deepseek-key K] [--minimax-key K]
./scripts/linux/install.sh status|start|stop|restart|logs|uninstall
./scripts/linux/install.sh key [minimax <ключ>]
```

## Структура

```
src/        мост (Node, ESM, без зависимостей)
tools/      сборка каталога, патч config.toml, управление ключами (Node)
templates/  шаблон описания модели для каталога Codex
scripts/    windows/ (PowerShell + VBS) и linux/ (bash + systemd)
docs/       архитектура, провайдеры, настройка, отладка
tests/      дымовые тесты без сети
```

## Проверено вживую

| Сценарий | Результат |
|---|---|
| Windows: `codex exec` на DeepSeek | `OK`, 60 176 токенов |
| Windows: `codex exec -c model=minimax-m3.1-flash` | `upstream: MiniMax-M3.1-Flash`, 200, `OK` |
| Windows: инструменты у DeepSeek и MiniMax | сам вызвал shell, верные ответы |
| WSL Ubuntu 24.04: `install.sh install` | служба active, ключи `0600`, `/health` отвечает |
| WSL: неверный ключ | HTTP 401 с текстом ошибки провайдера |
| WSL и Windows: `node tests/smoke.mjs` | 16 из 16 проверок |
| 429 от OpenAI | автоматический переход в DeepSeek, `fallback: deepseek` |
| Убийство процесса моста (Windows) | супервизор поднял новый за 7 секунд |

## Документация

- [Архитектура и трансляция протоколов](docs/architecture.md)
- [Провайдеры и уровни reasoning](docs/providers.md)
- [Настройка, конфиг, CLI, эндпоинты](docs/configuration.md)
- [Отладка и типовые ошибки](docs/troubleshooting.md)
- [Безопасность и работа с ключами](SECURITY.md)
- [История изменений](CHANGELOG.md)

## Тесты

```bash
node tests/smoke.mjs
```

Тест поднимает фальшивый Chat-Completions сервер и проверяет трансляцию, маршрутизацию, уровни
reasoning, инструменты и переход при 429. Сеть и ключи не нужны.

## Ограничения

- DeepSeek и MiniMax работают только в потоковом режиме, шифрованные reasoning-блоки не отдаются.
- Web search для этих двух провайдеров вырезается: API его не поддерживает.
- MiniMax-M3.1-Flash требует adaptive thinking, полностью отключить размышления нельзя.
- Каталог моделей требует полного описания модели: Codex отвергает неполный.

## Лицензия

MIT, см. [LICENSE](LICENSE).

#!/usr/bin/env bash
# Codex Router CLI для Linux (systemd --user) и macOS (запуск через nohup).
#
#   ./scripts/linux/install.sh install [--deepseek-key K] [--minimax-key K]
#   ./scripts/linux/install.sh status|start|stop|restart|logs|uninstall
#   ./scripts/linux/install.sh key [minimax <ключ>]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
INSTALL_DIR="$CODEX_HOME/codex-router"
CONFIG="$CODEX_HOME/config.toml"
CATALOG="$CODEX_HOME/models.mixed.json"
KEYS="$INSTALL_DIR/keys.json"
PORT="${PORT:-8788}"
SERVICE_NAME="codex-router"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"
NODE="${NODE:-$(command -v node || true)}"
PID_FILE="$INSTALL_DIR/router.pid"

need_node() {
    if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
        echo "node не найден. Установите Node.js 18+ или задайте NODE=/путь/к/node" >&2
        exit 1
    fi
}

has_systemd() {
    command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

health() {
    "$NODE" -e '
        const p = process.argv[1];
        fetch(`http://127.0.0.1:${p}/health`)
            .then(r => r.text())
            .then(t => { console.log(t); })
            .catch(() => process.exit(1));
    ' "$PORT" 2>/dev/null
}

ensure_dirs() {
    mkdir -p "$INSTALL_DIR/logs"
}

write_config() {
    local cfg="$INSTALL_DIR/codex-router.config.json"
    if [ ! -f "$cfg" ]; then
        printf '{\n  "port": %s\n}\n' "$PORT" > "$cfg"
    fi
}

install_router() {
    need_node
    ensure_dirs
    cp "$REPO_ROOT/src/codex-router.mjs" "$INSTALL_DIR/codex-router.mjs"
    write_config

    local ds_key="${DEEPSEEK_API_KEY:-}" mm_key="${MINIMAX_API_KEY:-}"
    while [ $# -gt 0 ]; do
        case "$1" in
            --deepseek-key) ds_key="$2"; shift 2 ;;
            --minimax-key) mm_key="$2"; shift 2 ;;
            *) shift ;;
        esac
    done
    [ -n "$ds_key" ] && "$NODE" "$REPO_ROOT/tools/keys.mjs" set --file "$KEYS" --provider deepseek --key "$ds_key"
    [ -n "$mm_key" ] && "$NODE" "$REPO_ROOT/tools/keys.mjs" set --file "$KEYS" --provider minimax --key "$mm_key"

    if [ ! -f "$KEYS" ]; then
        echo "Ключей нет. Введите ключ DeepSeek (ввод скрыт), либо задайте DEEPSEEK_API_KEY и повторите install."
        read -r -s -p "DeepSeek key: " typed || true
        echo
        if [ -n "${typed:-}" ]; then
            "$NODE" "$REPO_ROOT/tools/keys.mjs" set --file "$KEYS" --provider deepseek --key "$typed"
        else
            echo "Ключ не введён, ставлю мост без ключа DeepSeek." >&2
        fi
        unset typed
    fi

    "$NODE" "$REPO_ROOT/tools/build-catalog.mjs" --codex-home "$CODEX_HOME" \
        --template "$REPO_ROOT/templates/model-template.json" --out "$CATALOG"
    "$NODE" "$REPO_ROOT/tools/patch-config.mjs" --config "$CONFIG" --catalog "$CATALOG" --port "$PORT"

    if has_systemd; then
        mkdir -p "$SERVICE_DIR"
        sed -e "s|__NODE__|$NODE|g" -e "s|__ROUTER__|$INSTALL_DIR/codex-router.mjs|g" \
            -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
            "$REPO_ROOT/scripts/linux/codex-router.service" > "$SERVICE_FILE"
        systemctl --user daemon-reload
        systemctl --user enable --now "$SERVICE_NAME"
        echo "Служба systemd: $SERVICE_FILE"
    else
        start_nohup
        echo "systemd недоступен, запущено через nohup (pid в $PID_FILE)."
    fi

    sleep 2
    status || true
    echo
    echo "Готово. Перезапустите Codex, чтобы он прочитал config.toml."
}

start_nohup() {
    need_node
    ensure_dirs
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Уже запущен (pid $(cat "$PID_FILE"))."
        return 0
    fi
    nohup "$NODE" "$INSTALL_DIR/codex-router.mjs" >> "$INSTALL_DIR/logs/router.out.log" 2>&1 &
    echo $! > "$PID_FILE"
    echo "Запущен, pid $(cat "$PID_FILE")."
}

stop_nohup() {
    if [ -f "$PID_FILE" ]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        rm -f "$PID_FILE"
        echo "Остановлен."
    else
        pkill -f "$INSTALL_DIR/codex-router.mjs" 2>/dev/null && echo "Остановлен." || echo "Не запущен."
    fi
}

status() {
    echo "=== файлы ==="
    [ -f "$INSTALL_DIR/codex-router.mjs" ] && echo "  мост: $INSTALL_DIR/codex-router.mjs" || echo "  мост не установлен"
    [ -f "$KEYS" ] && echo "  ключи: $KEYS ($(stat -c '%a' "$KEYS" 2>/dev/null || echo '?') )" || echo "  ключей нет"
    echo "=== служба ==="
    if has_systemd; then
        systemctl --user is-active "$SERVICE_NAME" 2>/dev/null || true
    elif [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "nohup pid $(cat "$PID_FILE")"
    else
        echo "не запущен"
    fi
    echo "=== /health ==="
    health || echo "  мост не отвечает на :$PORT"
    echo "=== ключи ==="
    [ -f "$KEYS" ] && "$NODE" "$REPO_ROOT/tools/keys.mjs" list --file "$KEYS" || true
}

do_stop() {
    if has_systemd; then systemctl --user stop "$SERVICE_NAME"; else stop_nohup; fi
}

do_start() {
    if has_systemd; then systemctl --user start "$SERVICE_NAME"; else start_nohup; fi
}

do_uninstall() {
    if has_systemd; then
        systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
        rm -f "$SERVICE_FILE"
        systemctl --user daemon-reload || true
    else
        stop_nohup
    fi
    rm -rf "$INSTALL_DIR"
    echo "Удалено: $INSTALL_DIR"
    echo "config.toml не тронут."
}

case "${1:-}" in
    install) shift; install_router "$@" ;;
    start) do_start ;;
    stop) do_stop ;;
    restart) do_stop; sleep 1; do_start; sleep 2; status ;;
    status) status ;;
    logs)
        if has_systemd; then journalctl --user -u "$SERVICE_NAME" -n 50 --no-pager
        else tail -n 50 "$INSTALL_DIR/logs/router.out.log" 2>/dev/null || echo "логов нет"; fi
        ;;
    key)
        need_node
        shift
        if [ $# -ge 2 ]; then
            "$NODE" "$REPO_ROOT/tools/keys.mjs" set --file "$KEYS" --provider "$1" --key "$2"
            do_stop; sleep 1; do_start
        else
            "$NODE" "$REPO_ROOT/tools/keys.mjs" list --file "$KEYS"
        fi
        ;;
    uninstall) do_uninstall ;;
    *)
        echo "Использование: $0 {install|status|start|stop|restart|logs|key [provider key]|uninstall}" >&2
        exit 1
        ;;
esac

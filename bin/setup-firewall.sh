#!/usr/bin/env bash
# ============================================================
# AI-Gateway-Hub firewall helper (Linux)
#
# Usage:
#   bin/setup-firewall.sh add      - open inbound TCP port
#   bin/setup-firewall.sh remove   - close it
#   bin/setup-firewall.sh status   - print state (no sudo needed for ufw/iptables read)
#
# Auto-detects ufw / firewalld / iptables in that order.
# Reads port from project config.json (defaults to 44559).
# ============================================================
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname -- "$SCRIPT_DIR")"
CONFIG_FILE="$PROJECT_ROOT/config.json"

# ---- Resolve port from config.json ----
PORT=44559
if [ -f "$CONFIG_FILE" ]; then
    if command -v node >/dev/null 2>&1; then
        P=$(node -e "try { const c = require('$CONFIG_FILE'); process.stdout.write(String(c.port||44559)); } catch(e) { process.stdout.write('44559'); }" 2>/dev/null)
        if [ -n "${P:-}" ]; then PORT="$P"; fi
    else
        # crude grep fallback
        P=$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "$CONFIG_FILE" | head -1 | grep -oE '[0-9]+' || true)
        if [ -n "${P:-}" ]; then PORT="$P"; fi
    fi
fi

ACTION="${1:-status}"

# ---- Detect backend ----
BACKEND=""
if command -v ufw >/dev/null 2>&1; then
    BACKEND="ufw"
elif command -v firewall-cmd >/dev/null 2>&1; then
    BACKEND="firewalld"
elif command -v iptables >/dev/null 2>&1; then
    BACKEND="iptables"
else
    echo "[error] No supported firewall tool found (ufw / firewalld / iptables)." >&2
    exit 4
fi

need_sudo() {
    if [ "$(id -u)" -ne 0 ]; then echo "sudo"; else echo ""; fi
}

case "$ACTION" in
    status)
        case "$BACKEND" in
            ufw)
                if ufw status 2>/dev/null | grep -qE "(^|[[:space:]])$PORT(/tcp)?[[:space:]]+ALLOW"; then
                    echo "PRESENT backend=ufw port=$PORT"
                    exit 0
                fi
                ;;
            firewalld)
                if firewall-cmd --list-ports 2>/dev/null | tr ' ' '\n' | grep -qx "$PORT/tcp"; then
                    echo "PRESENT backend=firewalld port=$PORT"
                    exit 0
                fi
                ;;
            iptables)
                if iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
                    echo "PRESENT backend=iptables port=$PORT"
                    exit 0
                fi
                ;;
        esac
        echo "MISSING backend=$BACKEND port=$PORT"
        exit 1
        ;;
    add)
        SUDO=$(need_sudo)
        echo "[add] backend=$BACKEND opening TCP $PORT ..."
        case "$BACKEND" in
            ufw)
                $SUDO ufw allow "$PORT"/tcp comment 'ai-gateway-hub' || { echo "[add] FAILED"; exit 3; }
                ;;
            firewalld)
                $SUDO firewall-cmd --permanent --add-port="$PORT"/tcp || { echo "[add] FAILED"; exit 3; }
                $SUDO firewall-cmd --reload || true
                ;;
            iptables)
                $SUDO iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || \
                    $SUDO iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT || { echo "[add] FAILED"; exit 3; }
                ;;
        esac
        echo "[add] OK"
        exit 0
        ;;
    remove)
        SUDO=$(need_sudo)
        echo "[remove] backend=$BACKEND closing TCP $PORT ..."
        case "$BACKEND" in
            ufw)
                $SUDO ufw delete allow "$PORT"/tcp || true
                ;;
            firewalld)
                $SUDO firewall-cmd --permanent --remove-port="$PORT"/tcp || true
                $SUDO firewall-cmd --reload || true
                ;;
            iptables)
                $SUDO iptables -D INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || true
                ;;
        esac
        echo "[remove] OK"
        exit 0
        ;;
    *)
        echo "Unknown action: $ACTION  (use: add | remove | status)" >&2
        exit 2
        ;;
esac

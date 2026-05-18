#!/usr/bin/env bash
# AI-Gateway-Hub 控制面板 (Linux / macOS)
# 用法: ./ai-gateway.sh           — 交互菜单
#       ./ai-gateway.sh start     — 直接启动

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "[error] Node.js not found in PATH. Install from https://nodejs.org/" >&2
    exit 1
fi

exec node "$SCRIPT_DIR/ctl.mjs" "$@"

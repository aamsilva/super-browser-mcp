#!/bin/bash
# Wrapper: super-browser-mcp — portável (§51): sem paths pessoais hardcoded.
# - node: resolvido do PATH (ou SUPER_BROWSER_NODE / config server.node se definido)
# - segredos: o registo do MCP no OpenCode pode injetar env (mcp.env) — ver README.
#   Compat: se existir ~/.config/opencode/.secrets.env, carrega CAMOFOX_ACCESS_KEY.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[ -f "$HOME/.config/opencode/.secrets.env" ] && . "$HOME/.config/opencode/.secrets.env" 2>/dev/null
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${SUPER_BROWSER_NODE:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || NODE_BIN="$(command -v node)"
exec "$NODE_BIN" "$DIR/src/index.js" "$@"

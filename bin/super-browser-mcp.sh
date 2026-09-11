#!/bin/bash
# Wrapper: super-browser-mcp — portável (§27). Sem paths pessoais hardcoded.
# - node: do PATH (ou SUPER_BROWSER_NODE)
# - segredos: SUPER_BROWSER_SECRETS_FILE (opt-in) — preferível injetar env no mcp.json
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -n "${SUPER_BROWSER_SECRETS_FILE:-}" ] && [ -f "${SUPER_BROWSER_SECRETS_FILE}" ]; then
  . "${SUPER_BROWSER_SECRETS_FILE}"
fi
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${SUPER_BROWSER_NODE:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || NODE_BIN="$(command -v node)"
exec "$NODE_BIN" "$DIR/src/index.js" "$@"

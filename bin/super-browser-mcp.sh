#!/bin/bash
# Wrapper: super-browser-mcp — genérico, lê paths do config.json.
# Sem hardcoded de máquina: node e root vêm de config.json (server.node/server.root).
# Fix PATH (15-Ago): quando invocado pelo launchd, o PATH é mínimo
# (/usr/bin:/bin) sem node/opencli — o opencli faz `env node` internamente.
# Exportar PATH completo para o opencli e o node funcionarem.
export PATH="/Users/augustosilva/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(python3 -c "import json;print(json.load(open('$DIR/config.json')).get('server',{}).get('node','node'))" 2>/dev/null || echo node)"
exec "$NODE" "$DIR/src/index.js" "$@"

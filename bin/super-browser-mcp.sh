#!/bin/bash
# Wrapper: super-browser-mcp — genérico, lê paths do config.json.
# Sem hardcoded de máquina: node e root vêm de config.json (server.node/server.root).
# Fallback: node do PATH e raiz relativa a este script.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(python3 -c "import json;print(json.load(open('$DIR/config.json')).get('server',{}).get('node','node'))" 2>/dev/null || echo node)"
exec "$NODE" "$DIR/src/index.js" "$@"

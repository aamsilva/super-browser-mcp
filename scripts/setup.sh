#!/bin/bash
# setup.sh — instalação automatizada do super-browser-mcp.
# Idempotente: pode correr várias vezes. Detecta e instala cada dependência.
# Uso: bash scripts/setup.sh   (ou npm run setup)
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "=== super-browser-mcp setup (dir: $DIR) ==="

# 0. Node
if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -d. -f1 | tr -d v)" -ge 22 ]; then
  echo "[OK] Node: $(node -v)"
else
  echo "[FALTA] Node >= 22. Instala manualmente: https://nodejs.org"
  exit 1
fi

# 1. deps npm
echo "[1] npm install..."
(cd "$DIR" && npm install --silent)

# 3. CloakBrowser (stealth)
VENV="$DIR/.venv/bin/python3"
if [ -x "$VENV" ] && "$VENV" -c "import cloakbrowser" >/dev/null 2>&1; then
  echo "[OK] cloakbrowser (venv)"
else
  echo "[3] criar venv + instalar cloakbrowser..."
  python3 -m venv "$DIR/.venv"
  "$VENV" -m pip install --quiet cloakbrowser bs4
fi

# 4. camofox (engine primário stealth)
CAMOFOX_DIR="${CAMOFOX_DIR:-/Volumes/disco1tb/tools/camofox-browser}"
if [ -x "$CAMOFOX_DIR/run.sh" ] || [ -f "$CAMOFOX_DIR/server.js" ]; then
  echo "[OK] camofox: $CAMOFOX_DIR"
else
  echo "[AVISO] camofox não encontrado em $CAMOFOX_DIR (env CAMOFOX_DIR). browser_act/scrape_stealth precisam dele. git clone https://github.com/nicedayzhu/camofox-browser $CAMOFOX_DIR && (cd $CAMOFOX_DIR && npm install)"
fi

# 5. config.json
if [ ! -f "$DIR/config.json" ]; then
  echo "[5] criar config.json a partir do exemplo..."
  cp "$DIR/config.example.json" "$DIR/config.json"
  echo "  ! EDITA config.json com os paths da tua máquina"
else
  echo "[OK] config.json presente"
fi

# 6. teste
echo "[6] npm test..."
(cd "$DIR" && npm test) || echo "  (teste falhou — ver INSTALL.md Troubleshooting)"

echo "=== setup concluído. Próximo: registar o MCP (ver README/INSTALL.md) ==="

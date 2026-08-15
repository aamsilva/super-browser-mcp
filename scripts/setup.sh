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

# 2. opencli (nuclear)
if command -v opencli >/dev/null 2>&1; then
  echo "[OK] opencli: $(opencli --version 2>&1 | head -1)"
else
  echo "[2] instalar opencli (npm -g)..."
  npm install -g @jackwener/opencli
fi
# daemon
if opencli daemon status >/dev/null 2>&1; then
  echo "[OK] opencli daemon: running"
else
  echo "[2b] arrancar daemon..."
  opencli daemon restart || echo "  (daemon não estava a correr; restart tentado)"
fi

# 3. CloakBrowser (stealth)
VENV="$DIR/.venv/bin/python3"
if [ -x "$VENV" ] && "$VENV" -c "import cloakbrowser" >/dev/null 2>&1; then
  echo "[OK] cloakbrowser (venv)"
else
  echo "[3] criar venv + instalar cloakbrowser..."
  python3 -m venv "$DIR/.venv"
  "$VENV" -m pip install --quiet cloakbrowser bs4
fi

# 4. searxng (docker se disponível; senão avisar)
if curl -s -o /dev/null --max-time 3 "http://localhost:8081/" 2>/dev/null; then
  echo "[OK] searxng: http://localhost:8081"
elif command -v docker >/dev/null 2>&1; then
  if ! docker ps --filter name=searxng --format '{{.Names}}' | grep -q searxng; then
    echo "[4] arrancar searxng (docker)..."
    docker run -d -p 8081:8080 --name searxng searxng/searxng || echo "  (falhou; instalar manualmente — ver INSTALL.md passo 5)"
  else
    echo "[OK] searxng: container presente"
  fi
else
  echo "[AVISO] searxng ausente — web_search não funciona. Ver INSTALL.md passo 5."
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

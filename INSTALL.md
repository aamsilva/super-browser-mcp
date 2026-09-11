# Instalação — super-browser-mcp v1.5.35

Guia portável (macOS/Linux/WSL) para a arquitectura actual: **Camofox primário + CloakBrowser fallback + HTTP/API**.

> OpenCLI, Chrome bridge e SearXNG foram **removidos** (v1.5.28+) e **não** fazem parte desta instalação.

## 1. Pré-requisitos

```bash
# Node.js ≥ 22
brew install node            # macOS
# ou https://nodejs.org (Debian/Ubuntu: nodesource)

# Python 3.10+ (só para o fallback opcional CloakBrowser)
python3 --version
```

## 2. Instalar o MCP server

```bash
git clone https://github.com/aamsilva/super-browser-mcp.git
cd super-browser-mcp
npm install
npm run setup        # verifica node/deps/camofox, cria config, corre testes
```

## 3. Camofox (backend primário — obrigatório)

O runtime camofox é um projecto separado (Firefox stealth engine-level):

```bash
git clone https://github.com/nicedayzhu/camofox-browser "$CAMOFOX_DIR"  # ex: ~/camofox-browser
cd "$CAMOFOX_DIR" && npm install
```

Configurar caminho no MCP via env (nunca hardcoded):

```bash
export CAMOFOX_DIR="$HOME/camofox-browser"
```

O `super-browser-mcp` arranca o camofox **on demand** em `http://127.0.0.1:9377` (bind loopback, access key gerada pelo setup). Para manter o server sempre pronto, o MCP faz keep-alive a cada 5min.

### Sessões autenticadas (opcional mas é a razão de existir)

O camofox guarda cookies no próprio perfil (`~/.camofox/profiles/...`).
- Importância alta: importar cookies do teu Chrome real via `chrome2camofox.py` (scripts auxiliares do autor, não fazem parte do repo core).
- Alternativa: login assistido — navegar no camofox headed (config `interactive`) e autenticar manualmente + `clawbrowser://verify/`-equivalente via `auth_check` para provar.

## 4. CloakBrowser (fallback opcional)

Só necessário para `scrape_stealth` atrás de Cloudflare agressivo:

```bash
python3 -m venv .venv
.venv/bin/pip install cloakbrowser bs4
```

## 5. Configurar o MCP no teu cliente

OpenCode / Claude Code / Cursor (mcp.json):

```json
{ "mcp": { "super-browser": {
      "type": "local",
      "enabled": true,
      "command": [ "<caminho>/super-browser-mcp/bin/super-browser-mcp.sh" ],
      "env": { "CAMOFOX_DIR": "$HOME/camofox-browser",
               "SUPER_BROWSER_TELEMETRY": "metadata" } } } }
```

Env disponível (ver README): `CAMOFOX_URL`, `CAMOFOX_DIR`, `SUPER_BROWSER_SECRETS_FILE`, `SUPER_BROWSER_CLOAK_PY`, `SUPER_BROWSER_TELEMETRY`, `SUPER_BROWSER_ALLOW_PRIVATE`, `AGENT_BROWSER_BIN`.

## 6. Verificar

```bash
npm test
# smoker real:
cd super-browser-mcp
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bin/super-browser-mcp.sh | head -c 200
```

Health esperado: `backends.camoufox.available: true`.

## Troubleshooting

| Sintoma | Causa provável | Fix |
|---|---|---|
| `BACKEND_UNAVAILABLE` em todo o lado | camofox down / CAMOFOX_DIR errado | arrancar camofox + verificar `health` |
| `SECURITY_BLOCKED` em site público | DNS do host resolve IPv6 privado (rede interna) | só se intencional: `SUPER_BROWSER_ALLOW_PRIVATE=1` |
| `SESSION_NOT_FOUND` | seq de browser_act sem `open` primeiro | `open → …` |
| `UNSUPPORTED` com foreground | runtime é headless-only (design) | camofox interactive p/ login manual |
| 403 do camofox | access key não injetada | env `CAMOFOX_ACCESS_KEY` ou secrets file |

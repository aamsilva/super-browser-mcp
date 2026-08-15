# Instalação — super-browser-mcp

Recipe completa e genérica para instalar em **qualquer computador** (Mac/Linux/WSL), não só no Mac Mini de origem. Cobre todas as dependências de 3ª parte: opencli, CloakBrowser, searxng, Chrome bridge, Node.

> ⚠️ **Requisito crítico**: este projeto **delega** em 4 serviços externos. Sem eles, só as tools stateless puras funcionam. Instalar na ordem abaixo.

---

## Visão geral das dependências

| # | Dependência | O que faz | Obrigatória para |
|---|---|---|---|
| 1 | **Node.js ≥ 22** | runtime do MCP server | tudo |
| 2 | **opencli** | 175 adapters + Chrome bridge autenticado | finance_*, social_sentiment, browser_*, health |
| 3 | **Chrome + extensão opencli** | sessões autenticadas (X/Google/YouTube) | adapters COOKIE, browser_act |
| 4 | **CloakBrowser** | stealth scraping (Cloudflare) | scrape_stealth |
| 5 | **searxng** | pesquisa web multi-motor | web_search |

---

## 1. Pré-requisitos base

```bash
# Node.js ≥ 22 (recomendado 25+)
curl -fsSL https://deb.nodesource.com/setup_25.x | sudo -E bash - && sudo apt-get install -y nodejs   # Debian/Ubuntu
# ou no macOS:
brew install node

# Python 3.10+ (para CloakBrowser e scripts auxiliares)
# Git
```

## 2. Instalar o projeto

```bash
git clone https://github.com/aamsilva/super-browser-mcp.git
cd super-browser-mcp
npm install          # instala @modelcontextprotocol/sdk + zod
cp config.example.json config.json   # NÃO commitar config.json (tem paths locais)
```

## 3. Dependência: opencli (+ Chrome bridge) — a peça nuclear

O opencli é o que dá acesso aos 175 adapters e às sessões autenticadas.

```bash
# Instalar global
npm install -g @jackwener/opencli

# Verificar
opencli --version        # deve devolver versão
opencli list | wc -l     # deve devolver ~175 adapters

# O daemon (bridge browser persistente)
opencli daemon status    # se não estiver a correr:
opencli daemon restart
```

### Chrome + extensão opencli (para sessões autenticadas)

Os adapters COOKIE (X/Twitter, YouTube, Google, Reddit) precisam de um Chrome com a extensão opencli conectada:

1. Instalar Chrome
2. Carregar a extensão opencli (gerada em `~/.opencli/` após `opencli browser init` ou pela extensão oficial)
3. **Autenticar** manualmente os sites desejados numa janela Chrome com a extensão ligada (login no X, YouTube, Gmail, etc.)
4. Verificar: `opencli youtube whoami` → `{"logged_in": true}`

> **Importante**: o bridge Chrome é o que mantém as sessões. Fechar as tabs de sessão mata os cookies. A auth é por-utilizador — cada máquina tem os seus logins.

## 4. Dependência: CloakBrowser (stealth, para scrape_stealth)

```bash
# Criar venv e instalar
python3 -m venv .venv
.venv/bin/pip install cloakbrowser bs4   # cloakbrowser 0.5.7
```

Testar:
```bash
.venv/bin/python3 -c "import cloakbrowser; print('cloakbrowser OK')"
```

O `scrape_stealth` usa este venv para sites Cloudflare/anti-bot que o curl/opencli falham (403).

## 5. Dependência: searxng (multi-motor, para web_search)

Opção A — Docker (recomendado):
```bash
docker run -d -p 8081:8080 --name searxng searxng/searxng
```

Opção B — Python direto (se não tiveres Docker):
```bash
pip install searxng
# ou usar um serviço searxng remoto e apontar SUPER_BROWSER_SEARXNG_URL
```

Testar:
```bash
curl "http://localhost:8081/search?q=test&format=json"
```

## 6. Configurar o config.json (paths locais)

Edita `config.json` com os paths **da tua máquina** (nenhum hardcoded no código):

```json
{
  "opencli": { "bin": "<path do opencli, ex: /opt/homebrew/bin/opencli>" },
  "cloak": { "python": "<path do venv python, ex: /home/user/super-browser-mcp/.venv/bin/python3>" },
  "searxng": { "url": "http://localhost:8081" },
  "browser": { "defaultSession": "mcp-main" },
  "server": {
    "root": "<path do projeto>",
    "node": "<path do node, ex: /usr/local/bin/node>",
    "tailscaleIp": "<ip tailscale se aplicavel>"
  }
}
```

Alternativa: **env vars** (úteis em CI/VPS):

```bash
export SUPER_BROWSER_OPENCLI=/opt/homebrew/bin/opencli
export SUPER_BROWSER_CLOAK_PY=/path/to/.venv/bin/python3
export SUPER_BROWSER_SEARXNG_URL=http://localhost:8081
```

## 7. Registar numa tool MCP-client

**opencode** (`~/.config/opencode/opencode.json`):
```json
"mcp": {
  "super-browser": {
    "type": "local",
    "command": ["<path>/super-browser-mcp/bin/super-browser-mcp.sh"]
  }
}
```

**VS Code** (`~/Library/Application Support/Code/User/mcp.json`):
```json
"servers": {
  "super-browser": {
    "type": "stdio",
    "command": "<path>/super-browser-mcp/bin/super-browser-mcp.sh"
  }
}
```

**Claude Code / Cursor / Antigravity**: ver a doc de cada tool para registar um MCP server stdio com o mesmo comando.

O wrapper `bin/super-browser-mcp.sh` lê `server.node` e `server.root` do `config.json` — não precisa de edição.

## 8. Verificar a instalação

```bash
# Teste integrado (handshake + 10 tools com dados reais)
npm test

# Load test rápido (30 chamadas simultâneas)
node test/load_test.js 10 30
```

Resultado esperado:
```
[1] tools/list: 10 tools ✓
[2] finance_crypto: PASS
[3] browser stateful (open→fill→Enter→extract): PASS
RESULTADO: TODOS PASS ✓
```

## 9. Dashboard (opcional)

```bash
python3 serve_capabilities.py    # porta 8097 (LAN/Tailscale)
# ou via systemd/launchd com KeepAlive
```

---

## Troubleshooting de instalação

| Sintoma | Causa | Fix |
|---|---|---|
| `tools/list` só devolve 8 tools | versão antiga | `git pull && npm install` |
| `finance_quote` devolve UNDEFINED | bridge Chrome sem sessão barchart | `opencli daemon restart` |
| `social_sentiment` falha | X não autenticado no Chrome | login no X na janela com a extensão |
| `scrape_stealth` erro `No module cloakbrowser` | venv não criado | passo 4 |
| `web_search` timeout | searxng não a correr | `docker start searxng` |
| `--window background` unknown option | adapter PUBLIC puro | adicionar/remover de `windowAdapters` no config |

---

## Dependências declaradas no package.json

```
dependencies:
  @modelcontextprotocol/sdk  ^1.30.0   (protocolo MCP)
  zod                         ^4.4.3   (validação de schemas)
```
(Nenhuma lib de terceiros para dados — o acesso é via opencli/CloakBrowser/searxng.)

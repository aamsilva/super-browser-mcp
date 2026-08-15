# super-browser-mcp

> **As super browser capabilities do Mac Mini, expostas como tools MCP.**
> Um servidor MCP que dá a qualquer agente/ferramenta — opencode, VS Code, Antigravity, Claude Code, Cursor, ou um daemon na VPS — acesso às capacidades de browsing **autenticado** (X/Twitter, YouTube, Google), finance/trading (barchart, binance, defillama) e pesquisa multi-motor (searxng).

<p align="center"><img src="assets/super-browser-logo.svg" alt="super-browser-mcp" width="120"></p>

[![Node](https://img.shields.io/badge/node-%3E%3D25-blue)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.30.0-6f42c1)](https://github.com/modelcontextprotocol/sdk)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%28Mac%20Mini%29-999999)]()

---

## Porquê este projeto?

O problema que resolve: **sessões autenticadas não vivem em datacenters.**

O X/Twitter, Google, YouTube e Reddit exigem sessões humanas persistentes. Um VPS (Hetzner, AWS) não tem — e **não pode ter** (IP de datacenter, CAPTCHA, geo-block). O Mac Mini tem: o Chrome bridge do [opencli](https://github.com/jackwener/opencli) mantém 3 contas Google + X/Twitter + LinkedIn + GitHub + Reddit autenticados 24/7.

**super-browser-mcp** faz o decouple: transforma essas capacidades num servidor MCP padrão da indústria, consumível por qualquer tool. O opencli (e o Chrome) ficam no Mac Mini; o resto do mundo consome tools MCP.

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Mac Mini (edge browsing)   │         │  Consumidores                │
│                             │         │                              │
│  Chrome bridge (logged in)  │         │  opencode (MCP local)        │
│  opencli adapters (173+)    │  MCP    │  VS Code (mcp.json)          │
│  searxng (:8081)            │ stdio   │  Antigravity / Cursor        │
│  super-browser-mcp          ├────────▶│  Claude Code                 │
│    src/index.js             │  (HTTP  │  VPS / ARES (via Tailscale)  │
│                             │  fut.)  │                              │
└─────────────────────────────┘         └──────────────────────────────┘
```

## Tools

| Tool | Fonte | Tipo | Dados |
|---|---|---|---|
| `finance_quote` | Barchart | Público | preço, change, volume, high/low |
| `finance_options` | Barchart | Público | options chain + greeks (IV, delta, gamma, theta, vega) |
| `finance_crypto` | Binance | Público | preço, volume, depth, gainers |
| `finance_defi` | DefiLlama | Público | top DeFi por TVL + change 1d/7d |
| `social_sentiment` | **X/Twitter** | **Autenticado** | sentimento real de um ticker |
| `browser_browse` | opencli web | Autenticado | conteúdo de qualquer URL (markdown) |
| `web_search` | SearxNG | Público | pesquisa web multi-motor |
| `scrape_stealth` | CloakBrowser | **Stealth** | scraping Cloudflare/anti-bot (HTML renderizado) |
| `health` | opencli whoami | — | estado do bridge autenticado |

## Dashboard (webview UI)

`serve_capabilities.py` — dashboard local + API (porta **8097**, acessível por Tailscale):

```
http://100.74.228.17:8097/        # UI: monitoria, telemetria, testes manuais
http://100.74.228.17:8097/api/state    # estado vivo (JSON)
http://100.74.228.17:8097/api/call     # POST {name, args} → chama tool
http://100.74.228.17:8097/api/history  # telemetria (últimas 30 chamadas)
```

- **Monitoria**: estado do Chrome bridge, SearXNG, opencode serve (dots OK/FAIL)
- **Telemetria**: cada chamada registada (tool, ok/fail, latência) em SQLite
- **Métricas**: chamadas totais, erros, latência p50/p95
- **Testes manuais**: 9 cards com input real + botão → mostra input/output realtime
- **UI** com design neutro (não corporativo), logo `assets/super-browser-logo.svg`

Arranque: `python3 serve_capabilities.py` (ou launchd `com.govantis.super-browser-dashboard`).

## Quickstart

```bash
# 1. Instalar
cd /Volumes/disco1tb/tools/super-browser-mcp
npm install

# 2. Testar (verifica as 8 tools com dados reais)
npm test

# 3. Registar numa tool — opencode
#    ~/.config/opencode/opencode.json
"mcp": {
  "super-browser": {
    "type": "local",
    "command": ["/Volumes/disco1tb/tools/super-browser-mcp/bin/super-browser-mcp.sh"]
  }
}

# 4. Reiniciar o serve para carregar o MCP
launchctl kickstart -k gui/$(id -u)/com.opencode.serve
```

## Uso (linguagem natural)

Uma vez registado, qualquer agente MCP invoca as tools:

- **"Dá-me o preço da NVDA"** → `finance_quote {symbol: "NVDA"}` → `225.16 -0.06%`
- **"O que dizem no X sobre a AAPL?"** → `social_sentiment {query: "AAPL"}` → tweets reais autenticados
- **"Preço do BTC"** → `finance_crypto {pair: "BTCUSDT"}` → `63013.75`
- **"Top DeFi por TVL"** → `finance_defi {limit: 5}` → ranking
- **"Lê esta página"** → `browser_browse {url}` → markdown
- **"Pesquisa quantum computing"** → `web_search {query}` → resultados multi-motor

## Testes

`npm test` corre um cliente MCP real contra o servidor, validando:
1. **Handshake** — protocolo MCP initialize + tools/list (8 tools)
2. **Integração** — cada tool com dados reais (barchart, binance, defillama, twitter, searxng)
3. **E2E** — cenário real: sentimento de um ticker + quote

Resultado esperado (verificado 15-Ago-2026):
```
finance_quote:   1 itens (9s)
finance_options: 20 itens (9s)
finance_crypto:  1 itens (1s)
finance_defi:    3 itens (1s)
social_sentiment: 2 itens (4s)
web_search:      2 itens (1s)
health:          ok (2s)
```

### Load test (ver [LOAD_TEST.md](LOAD_TEST.md))

```
node test/load_test.js <concurrency> <total>
```

Resultados verificados (640 chamadas, 0% erros):
| Cenário | Throughput | p95 latência |
|---|---|---|
| 50 calls / 25 conc | 6.35 req/s | 5.2s |
| **120 calls / 40 conc** | **7.27 req/s** | **7.8s** |
| 250 calls / 100 conc | 6.00 req/s | 25.3s |

- **Teto prático: ~7.3 req/s**, 0% erros mesmo a 100 concurrent
- **Gargalo**: o Chrome bridge (não o protocolo MCP) — tools HTTP puras não congestionam
- Uso real do ARES (< 1 req/min) fica 7x abaixo do teto

## Arquitetura

### Decisões de design

| Decisão | Porquê |
|---|---|
| **Zod para schemas** | O MCP SDK 1.30 **exige** Zod (ou raw-shape). `{symbol: "string"}` plain falha silenciosamente → args `undefined`. |
| **`--window background` por-adapter** | Só adapters Chrome (barchart, twitter, youtube, bloomberg, web, google, reddit, instagram, facebook) aceitam o flag. Binance/coingecko/defillama **rejeitam** → o `oc()` deteta por whitelist. |
| **`stdio: ["ignore", "pipe", "pipe"]`** | O opencli **não pode** herdar o stdin do MCP (senão lê bytes do protocolo como input do user). |
| **Wrapper `.sh` nos configs** | Path estável a `/Users/augustosilva/.opencode/bin/node` (nunca `/usr/local/bin/node` — não existe no Mac Mini). |
| **Transport stdio agora, HTTP depois** | O ARES (VPS) consome via `serve_capabilities.py` (HTTP) — a camada MCP fica para agentes LLM interativos. |

### Componentes

```
super-browser-mcp/
├── src/index.js          # MCP server: 8 tools, cada uma proxy thin p/ opencli
├── bin/super-browser-mcp.sh  # wrapper (node path estável)
├── test/run.js           # teste integrado + E2E
└── package.json
```

### Fluxo de uma chamada

```
Cliente MCP → tools/call {name: "finance_quote", args: {symbol: "NVDA"}}
  → src/index.js: oc(["barchart", "quote", "NVDA"])
  → opencli barchart quote NVDA --window background --format json
  → Chrome bridge → barchart.com → JSON estruturado
  → {content: [{type: "text", text: JSON.stringify(data)}]}
```

## Manutenção

### Backup
- **Fonte de verdade**: `/Volumes/disco1tb/tools/super-browser-mcp/` (disco externo)
- **GitHub**: `https://github.com/aamsilva/super-browser-mcp` (backup + histórico)

### Regras
1. **Nunca commitar** `node_modules/` — reinstalar com `npm install`
2. **Nunca mudar o node path** nos configs — usar o wrapper
3. **Novo adapter?** — adicionar ao `WINDOW_ADAPTERS` se usa Chrome
4. **Atualizar SDK?** — `npm update @modelcontextprotocol/sdk zod`, re-testar `npm test`

### Troubleshooting
| Sintoma | Causa | Fix |
|---|---|---|
| `--window background` erro | adapter sem flag | adicionar ao `WINDOW_ADAPTERS` ou remover |
| args `undefined` | schema não-Zod | usar `z.string()` |
| opencli lê bytes do MCP | stdin herdado | `stdio: ["ignore",...]` |
| bridge perdeu auth | tab de sessão fechada | `opencli browser main open <url>` |

## Roadmap
- [x] 8 tools MCP (quote, options, crypto, defi, sentiment, browse, search, health)
- [ ] `serve_capabilities.py` — exposição HTTP para o ARES/VPS
- [ ] Camada de cache + rate-limit
- [ ] Whitelist + auth token para acesso remoto

## Licença
MIT

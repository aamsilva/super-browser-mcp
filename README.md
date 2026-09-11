<div align="center">
<img src="assets/super-browser-logo.svg" alt="super-browser-mcp" width="120">

# super-browser-mcp

**Agentic browser runtime para OpenCode — MCP server.**

[![Version](https://img.shields.io/badge/version-1.5.35-2ea44f)](https://github.com/aamsilva/super-browser-mcp/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.30.0-6f42c1)](https://github.com/modelcontextprotocol/sdk)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Camofox](https://img.shields.io/badge/backend-camofox%20%28stealth%29-d9552a)]()

</div>

## O que é

Servidor MCP que dá browser automation **autenticada + stealth** a qualquer agente LLM (OpenCode, Claude Code, VS Code, Cursor, ARES/VPS via Tailscale), com sessões persistentes, autenticação por evidência, guarda de segurança SSRF e telemetria privacy-safe.

O problema que resolve: **sessões autenticadas não vivem em datacenters.** O X/Twitter, Google, YouTube, Reddit e sites Comcast/RDK exigem sessões humanas persistentes; um VPS não pode tê-las de forma fiável (IP de datacenter, CAPTCHA, geo-block). Este runtime mantém 18 sessões vivas num **camofox local headless** e expõe-nas como tools MCP padrão.

## Arquitectura (v1.5.35)

```text
OpenCode / MCP Client
      |
      v
MCP Server (src/index.js)          ← tool surface para o LLM
      |
      ├── BrowserRouter            ──→  Camoufox (primário, Firefox stealth headless)
      │                                 └ fallback: CloakBrowser (Chromium stealth, scrape_stealth)
      │
      ├── HTTP/API backend         ──→  Binance · DefiLlama · Firebase (dados públicos estruturados)
      │
      ├── AuthService (src/auth.js)──→  VERIFIED · CACHED · UNKNOWN · EXPIRED ·
      │                                 UNAUTHENTICATED · BLOCKED (evidence-based)
      ├── Session Manager (browser_act) ──→ stateful por sessionKey + recuperação server-side
      │
      └── Telemetry (SQLite)       ──→  metadata-only por defeito; >14 dias sai

Dashboard: http://<ip>:8097/  (telemetria latência/erros/engines em tempo real)
```

**Removido** (migração histórica): OpenCLI + Chrome bridge (v1.5.28, −3GB/18 processos) e SearXNG (16-Ago-2026). Não há fallback silencioso para arquitectura morta.

## Tools (17)

| Tool | Backend | Notas |
|---|---|---|
| `browser_browse` | camofox → cloakbrowser | navegação + extracção semântica/snapshot |
| `browser_act` | camofox | open/state/extract/click/type/fill/keys/scroll/wait/eval/screenshot/back/forward/refresh/close/tab/upload + **batch `actions[]`** |
| `browser_agent` | agent-browser (opcional) | sites que o camofox não cobre (amazon/booking) — env `AGENT_BROWSER_BIN` |
| `scrape_stealth` | camofox → cloakbrowser | HTML renderizado por trás de Cloudflare/anti-bot |
| `camofox_search` | camofox | Google SERP estruturado + fallback Bing |
| `web_search` | google → bing | web search com engine metadata |
| `site_search` | camofox/HTTP/RSS | búsqueda por site (youtube/twitter/reddit/defillama/…) |
| `social_sentiment` | camofox | X (rota hashtag, degradation-aware) |
| `finance_quote` / `finance_options` | barchart (camofox) | preço + options chain |
| `finance_crypto` / `finance_defi` | **HTTP directo** | binance/defillama |
| `auth_check` / `auth_status` / `auth_audit` | **AuthService** | estados com evidence |
| `camofox_auth_status` | camofox profile | hint por localStorage/cookie (nunca prova) |
| `health` | — | backends + versão |

## Modelo de autenticação

Nunca se afirma `VERIFIED` sem navegação real (evidence `{url, probe}`):

```json
{ "site":"github", "state":"VERIFIED", "verified":true, "checkedAt":"…", "evidence":{"url":"…/settings/profile","probe":"loaded_authenticated_page"} }
```

| Estado | Significado |
|---|---|
| `VERIFIED` | probe de navegação recente confirma a sessão |
| `CACHED` | verificação anterior dentro do TTL (verified=false) |
| `UNKNOWN` | sem evidência (nunca fabricado) |
| `EXPIRED` | era conhecido; deixou de ser válido |
| `UNAUTHENTICATED` | servidor redireccionou para login |
| `BLOCKED` | acesso existe mas permissão negada (ex: AccessDenied de guests) |

## Segurança

- **SSRF guard central** (`guardUrl`): bloqueia `file:`/`ftp:`/`data:`, loopback, RFC1918, link-local (169.254 incl. cloud-metadata), IPv6 privado/mapped, e DNS que resolve a IP privado (anti-rebind). Escape: `SUPER_BROWSER_ALLOW_PRIVATE=1`.
- **Erros estruturados**: `INVALID_ARGUMENT · SESSION_NOT_FOUND · BACKEND_UNAVAILABLE · UNSUPPORTED · SECURITY_BLOCKED · ELEMENT_NOT_FOUND`, sempre com `retryable`.
- **Validação Zod strict** em todos os schemas de tool.
- **Sem segredos em código/logs**; env injetado (ver Setup).
- Camofox corre local (bind 127.0.0.1), access key em env.

## Sessões

- `browser_act` é **stateful por sessão**: open → fill → click funcionam em sequência na mesma página.
- A sessão é **recuperável entre processos** (server-side `sessionKey`).
- Correlação OpenCode: `_meta.sessionID` → session `oc-<hash>` para tools de browser quando o caller não passa session (ownership — nunca autenticação).
- `window:"foreground"` → `UNSUPPORTED` (o camofox é headless-only por design).

## Telemetria (privacy-safe)

Metadata-only **por defeito** (tool, latency, erro, engine, byte-count; `result_summary` sem conteúdo de página). Opt-in debug: `SUPER_BROWSER_TELEMETRY=full` (mantém payload **com redação ativa** de tokens/cookies/headers). Registros >14 dias são purgados automaticamente.

## Configuração

`config.json` é runtime (não commitado). Exemplo portável em `config.example.json`. Variáveis principais:

| Env | Uso | Default |
|---|---|---|
| `CAMOFOX_URL` | runtime camofox | `http://127.0.0.1:9377` |
| `CAMOFOX_DIR` | onde está o camofox (spawn) | config `camofox.dir` |
| `SUPER_BROWSER_SECRETS_FILE` | opt-in de secrets file | — |
| `SUPER_BROWSER_CLOAK_PY` | snake CloakBrowser | repo `.venv` |
| `SUPER_BROWSER_TELEMETRY` | metadata \| full | `metadata` |
| `SUPER_BROWSER_ALLOW_PRIVATE` | escape SSRF | unset |

## Setup

```bash
npm run setup     # node ≥22, npm install, camofox check, config, testes
```

Wrapper portátil: `bin/super-browser-mcp.sh` (sem paths pessoais).

Registo no OpenCode:

```json
{ "mcp": { "super-browser": {
      "type": "local", "enabled": true,
      "command": [ "<repo>/bin/super-browser-mcp.sh" ],
      "env": { "CAMOFOX_DIR": "</path/to/camofox>",
               "SUPER_BROWSER_SECRETS_FILE": "<optional>" } } } }
```

## Testes / Load

```bash
npm test          # 9 checks: MCP handshake, tools, auth evidence, SSRF, batch, stateful flow, unit redact
```

`LOAD_TEST.md` descreve benchmarks da arquitectura camofox (compras/multi-sessão p50/p95).

## Dashboard

`serve_capabilities.py` + `dashboard/` → http://IP:8097/ — latência por tool, erros, uso por engine, cache hit, backends em tempo real.

## Histórico

Ver [Releases](https://github.com/aamsilva/super-browser-mcp/releases). Migrations principais: v1.5.28 (opencli elim), v1.5.33 (hardening 1: dead-paths/SSRF/telemetry), v1.5.35 (AuthService/batching/portabilidade).

## Licença

MIT — © Augusto Silva

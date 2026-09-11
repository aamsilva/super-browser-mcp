# SUPER-BROWSER-MCP — Onboarding para sessões opencode (T1/T2/T3)

> **Regra de prioridade (AGENTS.md §BROWSER STACK):** TODO webscrapping, websearch e acesso web
> autenticado é feito pelo **super-browser-mcp** (camofox-first). NÃO usa opencli/Chrome/searxng
> diretamente (removidos v1.5.28+). O MCP agrega e centraliza; os backends são internos.

## O que é
MCP server Node com **Camofox (Firefox stealth headless) como primário**, CloakBrowser como stealth
fallback (scrape_stealth) e HTTP/API directo para dados públicos. **17 tools MCP**, sessões stateful
por sessionKey com recuperação server-side, autenticação por evidência (AuthService), SSRF guard,
telemetria metadata-only. Consumível por OpenCode, Claude Code, VS Code, Cursor e VPS (Tailscale).

## Acesso
- **Repo/docs**: https://github.com/aamsilva/super-browser-mcp (README = fonte de verdade)
- **Dashboard webui**: `http://100.74.228.17:8097/` (telemetria, perf por engine, testes manuais)
- **Source**: `/Volumes/disco1tb/tools/super-browser-mcp/`
- **Camofox (primário)**: `/Volumes/disco1tb/tools/camofox-browser/` (:9377, access key em .secrets.env)

## Tools — casos de uso (17)
| Tool | Uso |
|---|---|
| `site_search` | Busca por site: youtube (search/feed/subs), twitter (trending/timeline), google (news/search), reddit, bbc, hackernews, defillama, barchart, github, linkedin |
| `finance_quote` / `finance_options` | Preço + options chain + greeks (barchart via camofox) |
| `finance_crypto` / `finance_defi` | Binance / DefiLlama (HTTP directo, sem browser) |
| `web_search` | Pesquisa web (google → bing fallback, engine metadata) |
| `camofox_search` | SERP Google stealth + fallback Bing |
| `social_sentiment` | Sentimento de ticker via X (rota hashtag; degraded-aware) |
| `browser_browse` | Ler qualquer página (snapshot semântico bounded) |
| `browser_act` | Interacção stateful (open/fill/click/eval/…) + batch `actions[]` |
| `scrape_stealth` | HTML renderizado detrás de anti-bot (camofox → cloakbrowser) |
| `browser_agent` | (opcional) agent-browser para amazon/booking — env AGENT_BROWSER_BIN |
| `auth_check` / `auth_status` / `auth_audit` | Estados de aut: VERIFIED/CACHED/UNKNOWN/EXPIRED/UNAUTHENTICATED/BLOCKED com evidence |
| `camofox_auth_status` | Hint de cookies no perfil (nunca prova) |
| `health` | Backends (camofox/cloak/http) + opencode serve + versão |

## Estados de aut (nunca inventar)
`UNKNOWN` = nunca verificado nesta corrida do MCP → **usar auth_check** antes de assumir.
`auth_audit(refresh=false)` devolve cached/UNKNOWN honesto; `refresh=true` re-verifica (~60s).

## Regras de convivência
1. **Camada anti-throttle/rekurs**: site_search > web_search > browser em sites pesados (X).
2. Rate limits: X throttlou /search p/ headless — usar social_sentiment (hashtag) em vez de browser_act no X.
3. SSRF: URLs internas (Tailscale, RFC1918) bloqueadas — SUPER_BROWSER_ALLOW_PRIVATE=1 se de propósito.
4. Camofox down → `health` mostra `backends.camoufox.available:false`; restart automático no próximo call (warm boot <8s).
5. Telemetria: `capabilities_state.db` (metadata-only). Dashboard reflete só o que passou pelo MCP (stdio incluído).

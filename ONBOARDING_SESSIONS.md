# SUPER-BROWSER-MCP — Onboarding para sessões opencode (T1/T2/T3)

> **Regra de prioridade (AGENTS.md §BROWSER STACK, reforçada 15-Ago):**
> **TODO webscrapping, websearch e acesso web autenticado deve ser feito PRIORITARIAMENTE
> pelo super-browser-mcp (MCP), e NÃO por opencli/stealth browser/searxng/agent-browser
> diretamente.** O MCP agrega e centraliza; as ferramentas são backends do MCP.

## O que é
MCP server Node que agrega todas as capacidades web do Mac Mini (opencli 175 adapters,
Chrome bridge autenticado, CloakBrowser stealth, searxng) expostas como **13 tools MCP**,
consumíveis por opencode, VS Code, Antigravity, Cursor, e remotamente pela VPS.

## Acesso
- **Repo/documentação**: `https://github.com/aamsilva/super-browser-mcp` (README + INSTALL + LOAD_TEST)
- **Dashboard webui**: `http://100.74.228.17:8097/` (monitoria, telemetria, testes manuais por card, markup inspecionável via "Ver markup completo")
- **Logs/traceability**: `http://100.74.208.17:8097/api/trace` (quem, source, caller, params, tempo, resultado)
- **Source**: `/Volumes/disco1tb/tools/super-browser-mcp/`

## As 13 tools (use cases suportados)
| Tool | Uso |
|---|---|
| `site_search` | Busca num site específico: youtube (search/feed/subs), twitter (trending/timeline/search/bookmarks), google (news/search/trends), reddit, bbc, hackernews |
| `finance_quote` / `finance_options` | Preço + options chain + greeks (barchart) |
| `finance_crypto` | Preço crypto (binance, HTTP direto) |
| `finance_defi` | Top DeFi por TVL (defillama, HTTP direto) |
| `social_sentiment` | Sentimento de ticker no X/Twitter (autenticado) |
| `browser_browse` | Ler conteúdo de qualquer URL (markdown + content) |
| `browser_act` | Automação browser: open/fill/click/type/select/keys/wait/eval/screenshot — stateful (sessão) + foreground (auth manual) |
| `web_search` | Pesquisa web multi-motor (searxng) |
| `scrape_stealth` | Scraping Cloudflare/anti-bot via CloakBrowser (HTML renderizado) |
| `auth_status` | Estado de sessão por site (parser) |
| `auth_check` | **Auth fiável**: navega p/ página só-autenticada e verifica redirect /login (o whoami NÃO é fidedigno) |
| `health` | Estado do bridge autenticado |

## Como usar numa sessão
As tools MCP aparecem como `super-browser_*` (ou `mcp__super-browser__*`) no toolset do opencode.
Pedir em linguagem natural: "pesquisa X no YouTube", "preço da NVDA", "sentimento do TSLA no X",
"lê esta página", "faz scrape do expresso", "verifica se o reddit está autenticado".

## REGRAS
1. **SEMPRE preferir super-browser MCP** a opencli/browser direto para tarefas web.
2. **NUNCA duplicar rotinas**: as rotinas diárias (notícias, monitoria, ARES) devem usar o MCP.
3. **Erros → feedback**: qualquer falha/erro/use case em falta → reportar (queue) para a sessão T1 (dono do super-browser) com: tool, args, erro exato, expectativa.
4. **Seleção de fonte**: se o MCP devolve dados, usar esses (já normalizados); NÃO re-chamar opencli.

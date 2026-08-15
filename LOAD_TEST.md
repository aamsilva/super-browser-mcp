# Load Test — super-browser-mcp

Data: 15-Ago-2026 · Método: cliente MCP real por chamada, timeout 60s · Toolset: web_search, finance_crypto, finance_defi, health

## Resultados Funcionais

| Teste | Chamadas | Concurr. | OK | FAIL | Erros % | Wall (s) | Throughput (req/s) |
|---|---|---|---|---|---|---|---|
| 1 (baseline) | 20 | 10 | 20 | 0 | **0%** | 5.3 | 3.79 |
| 2 (escalonado) | 50 | 25 | 50 | 0 | **0%** | 7.9 | 6.35 |
| 3 (100+) | **120** | 40 | **120** | 0 | **0%** | 16.5 | **7.27** |
| 4 (stress) | 200 | 60 | 200 | 0 | **0%** | 27.4 | 7.31 |
| 5 (rutura) | 250 | 100 | 250 | 0 | **0%** | 41.7 | 6.00 |

**Conclusão funcional**: 0% de erros em todas as 640 chamadas. Nenhuma falha, timeout, ou resposta malformada até 100 processos MCP simultâneos.

## Resultados Não Funcionais

### Latência (ms) por cenário
| Teste | avg | p50 | p95 | max |
|---|---|---|---|---|
| 20 calls / 10 conc | 1754 | 1816 | 3268 | 3268 |
| 50 calls / 25 conc | 3126 | 3420 | 5158 | 5188 |
| 120 calls / 40 conc | 4617 | 4947 | 7762 | 7837 |
| 200 calls / 60 conc | 7308 | 7563 | 12000 | 13139 |
| 250 calls / 100 conc | 14562 | 14591 | **25309** | 30275 |

### Per-tool (120 calls / 40 conc)
| Tool | avg ms | Comportamento |
|---|---|---|
| web_search | 2126 | mais rápido (searxng, sem Chrome) |
| finance_defi | 4968 | HTTP puro |
| finance_crypto | 5145 | HTTP puro |
| health | 6229 | Chrome bridge (whoami) |

### Capacidade máxima
- **Teto prático de throughput: ~7.3 req/s** (alcançado aos 60-120 chamadas)
- **Ponto de rutura de latência: 60+ concurrent** — p95 dispara de 7.8s → 12s → 25s
- **Nunca erro**: mesmo a 100 concurrent, 0% falhas (só latência degrada)
- **Gargalo**: o Chrome bridge é o ponto único — cada tool que usa Chrome (health, e em produção barchart/twitter) compete pelo mesmo bridge. As tools HTTP puras (web_search) não congestionam.

## Observações / Limitações
- **Cenário realista**: o ARES chamará 1-5 req/min, não 60+ concurrent. O throughput real exigido (<< 1 req/s) é 7x abaixo do teto.
- **O teto é do Chrome bridge, não do MCP**: o protocolo MCP stdio respondeu 100% das vezes.
- **Para escala > 10 req/s**: seria necessário (a) múltiplos profiles Chrome, ou (b) cache por símbolo no MCP, ou (c) mover tools HTTP puras (crypto/defi/web_search) para fora do bridge.

## Requisitos de infra (medidos)
- 1 processo MCP por chamada: pico de 100 processos node simultâneos, ~46MB RAM cada (46624KB medido) ≈ **4.6GB** no pior caso (só sob carga extrema; o normal é 1 processo persistente).
- CPU: stress de 250 chamadas não degradou o Mac Mini (health 200 pós-teste).

## Verificação pós-teste
- Bridge autenticado: ✅ `youtube whoami logged_in: true`
- Serve opencode: ✅ `/session 200`
- Zombies: ✅ 0 (nada ficou pendurado)

## Benchmark Web Scraping (15-Ago-2026, [VERIFICADO])

### Camadas de scraping (mesmo site: news.ycombinator.com)
| Camada | Tempo | Conteúdo | Uso |
|---|---|---|---|
| **opencli web.read** | 2.55s | 154 chars (JSON) | Sites simples, dados estruturados |
| **agent-browser** (headless) | 0.44s | 46 chars (título) | Extracção leve, sem render |
| **CloakBrowser** (stealth) | 2.93s | **34,393 chars HTML renderizado** | Cloudflare/anti-bot, JS completo |

### Cenário crítico: expresso.pt (Cloudflare)
| Método | Resultado |
|---|---|
| `curl` direto | **403** (bloqueado) |
| **CloakBrowser** | **1.81s, 344KB HTML renderizado** ("Expresso | Liberdade para pensar") |

### Conclusões
1. **CloakBrowser é a única camada que passa Cloudflare** — o opencli web.read e o curl falham a 403.
2. **CloakBrowser dá o HTML completo renderizado** (34-344KB) vs opencli web.read (154 chars JSON estruturado) — são complementares, não substitutos.
3. **Latência**: opencli web.read 2.55s (HTTP puro) ≈ CloakBrowser 2.93s (stealth Chromium). O stealth não é mais lento que o HTTP puro em sites normais.
4. **Hierarquia recomendada**: adapter → opencli web.read → CloakBrowser (se 403/Cloudflare) → agent-browser (extracção leve).
5. **super-browser-mcp NÃO expõe CloakBrowser ainda** — gap: adicionar tool `scrape_stealth(url)` que usa o venv.

## Load Test v2 (15-Ago-2026) — após cache TTL + HTTP direto

### Cenário A — Tools HTTP-only (finance_crypto/defi/web_search, sem Chrome bridge)
| Chamadas | Concurr. | OK | Erros % | Throughput | Wall |
|---|---|---|---|---|---|
| 120 | 40 | 120 | **0%** | **12.74 req/s** | 9.4s |
| 250 | 100 | 250 | **0%** | **11.62 req/s** | 21.5s |

**Melhoria vs v1**: 7.3 → 12.7 req/s (+75%), e **0% erro mesmo a 100 concurrent** (antes 6 req/s + latência 25s).

### Cenário B — Com health (Chrome bridge) no mix
| Chamadas | Concurr. | OK | Erros % | Nota |
|---|---|---|---|---|
| 120 | 40 | 101 | **15.8%** | health (youtube whoami via Chrome) satura |
| 40 | 40 | 30 | **25%** | timeouts 60s no health |

**Conclusão**: o gargalo é o **Chrome bridge** (1 sessão única), NÃO o MCP nem as APIs. O health faz `opencli youtube whoami` que usa o bridge — satura com >10 processos concorrentes.

### Impacto do cache TTL
- `finance_crypto` 1.5s → **0.37s** (HTTP direto, elimina spawn opencli)
- `finance_defi` 0.6s → **0.25s**
- Chamadas repetidas dentro de 60s: **1ms** (cache hit, sem spawn)

### Recomendações de escala
1. **Uso real** (ARES/agentes: <5 req/min) — folga enorme, irrelevante
2. **Health/Chrome tools** em produção: NUNCA em concorrência alta; o bridge é 1 sessão
3. **Para >15 req/s**: adicionar 2º profile Chrome (multi-context) OU cache antecipado (refresh em background)

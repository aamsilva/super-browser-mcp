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

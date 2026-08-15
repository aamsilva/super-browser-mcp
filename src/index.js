#!/usr/bin/env node
/**
 * super-browser-mcp — MCP server que expõe as capacidades de browsing/finance
 * do Mac Mini como tools MCP. Consumível por QUALQUER ferramenta: opencode,
 * VS Code, Antigravity, Claude Code, Cursor, e remotamente pela VPS.
 *
 * Decouple: o opencli (Chrome bridge autenticado) fica no Mac Mini; cada tool
 * MCP é um proxy thin para `opencli <adapter> <cmd> --format json` ou
 * `opencli browser ...`. 0 lógica de scraping aqui — os adapters entregam JSON.
 *
 * Transport: stdio (local) — exposto remotamente via serve_capabilities.py (HTTP).
 * NOTE: schemas em formato JSON Schema (o SDK 1.30 não aceita {sym:"string"}).
 */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { execFileSync } = require("child_process");
const { z } = require("zod");

const OPENCLI = "/opt/homebrew/bin/opencli";

/** Executa opencli <args...> --format json e devolve JSON parseado.
 *  --window background: só para adapters que usam Chrome (barchart, twitter,
 *  youtube, etc.) — adapters PUBLIC puros (binance, coingecko, defillama)
 *  rejeitam o flag. stdio ignore: o opencli não herda o stdin do MCP. */
const WINDOW_ADAPTERS = new Set(["barchart", "twitter", "youtube", "bloomberg", "web", "google", "reddit", "instagram", "facebook"]);
function oc(args, { timeout = 45000 } = {}) {
  const full = WINDOW_ADAPTERS.has(args[0]) ? [...args, "--window", "background", "--format", "json"]
                                             : [...args, "--format", "json"];
  try {
    const out = execFileSync(OPENCLI, full, {
      timeout, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (e) {
    const msg = (e.stdout || e.message || "").toString().trim();
    try { return JSON.parse(msg); } catch { return { ok: false, error: msg.slice(0, 300) }; }
  }
}

const server = new McpServer({ name: "super-browser", version: "1.0.0" });

// ---- Finance / Trading (subskill trading-search) ----
server.tool("finance_quote", "Cotações e dados de ações (barchart).",
  { symbol: z.string().describe("Ticker (ex: NVDA)") },
  async ({ symbol }) => {
    const d = oc(["barchart", "quote", symbol]);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

server.tool("finance_options", "Cadeia de opções + greeks + IV (barchart).",
  { symbol: z.string().describe("Ticker (ex: NVDA)") },
  async ({ symbol }) => {
    const d = oc(["barchart", "options", symbol]);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

server.tool("finance_crypto", "Preço crypto (binance).",
  { pair: z.string().describe("Par (ex: BTCUSDT)") },
  async ({ pair }) => {
    const d = oc(["binance", "price", pair]);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

server.tool("finance_defi", "Top DeFi por TVL (defillama).",
  { limit: z.number().optional().describe("Quantos protocolos") },
  async ({ limit = 5 }) => {
    const d = oc(["defillama", "protocols", "--limit", String(limit)]);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

// ---- Sentimento social (autenticado via Chrome) ----
server.tool("social_sentiment", "Sentimento social de um ticker (X/Twitter autenticado).",
  { query: z.string().describe("Query (ex: NVDA OR NVIDIA)"), limit: z.number().optional() },
  async ({ query, limit = 5 }) => {
    const d = oc(["twitter", "search", query, "--limit", String(limit)]);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

// ---- Browser genérico (qualquer site, Chrome bridge autenticado) ----
server.tool("browser_browse", "Navega para qualquer URL e extrai conteúdo (markdown).",
  { url: z.string().describe("URL completo") },
  async ({ url }) => {
    const d = oc(["web", "read", url]);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

// ---- Web search multi-motor (searxng via HTTP local) ----
server.tool("web_search", "Pesquisa web multi-motor (searxng).",
  { query: z.string().describe("Query"), limit: z.number().optional() },
  async ({ query, limit = 5 }) => {
    const res = await fetch(`http://localhost:8081/search?q=${encodeURIComponent(query)}&format=json`);
    const d = await res.json();
    const items = (d.results || []).slice(0, limit).map((r) => ({
      title: r.title, url: r.url, snippet: (r.content || "").slice(0, 200),
    }));
    return { content: [{ type: "text", text: JSON.stringify(items) }] };
  });

// ---- Health ----
server.tool("health", "Estado do super-browser-mcp + conectividade.",
  {},
  async () => {
    const bridge = oc(["youtube", "whoami"]);
    return { content: [{ type: "text", text: JSON.stringify({
      ok: true, bridge_auth: bridge && bridge.logged_in ? "logged_in" : "unknown", time: new Date().toISOString(),
    }) }] };
  });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((e) => { console.error("[super-browser-mcp] fatal:", e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * super-browser-mcp — MCP server que expõe as capacidades de browsing/finance
 * do Mac Mini como tools MCP. Consumível por QUALQUER ferramenta: opencode,
 * VS Code, Antigravity, Claude Code, Cursor, e remotamente pela VPS.
 *
 * ## Orquestração (como as skills se ligam ao MCP)
 *
 * Este servidor é o ponto de decouple: o opencli (Chrome bridge autenticado),
 * o CloakBrowser (stealth) e o searxng (search) vivem no Mac Mini; aqui são
 * expostos como tools MCP. Nenhum scraping está neste ficheiro — cada tool
 * delega numa camada de execução:
 *
 *   adapter tool (finance_* / social_*)  → opencli <adapter> <cmd> --format json
 *   browser_browse                        → opencli web read <url>
 *   browser_act (interativo)              → opencli browser <action> (fill/click/type/...)
 *   scrape_stealth                        → CloakBrowser (venv python, stealth Chromium)
 *   web_search                            → searxng (localhost HTTP)
 *
 * Referência de skills relacionadas (no Mac Mini):
 *   agentic-browsing   → decision tree de navegação (adapter > browser > stealth)
 *   trading-search     → fontes finance/trading multi-fonte
 *   opencli-browser    → contrato dos comandos browser (selectors, envelopes)
 *   page-agent         → automação GUI in-page (Alibaba, forms complexos)
 *
 * ## Configuração
 * Tudo o que é máquina-específico (paths, URLs) está em config.json (ver
 * config.example.json) ou em env vars SUPER_BROWSER_*. Sem hardcoded de
 * sistema — portável para qualquer host.
 */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { execFileSync } = require("child_process");
const { z } = require("zod");
const path = require("path");
const fs = require("fs");

// ---- Config (genérico: env > config.json > default) ----
function loadConfig() {
  const p = path.join(__dirname, "..", "config.json");
  let file = {};
  try { file = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* usa defaults/env */ }
  const e = (k, d) => process.env[k] !== undefined ? process.env[k] : d;
  return {
    opencliBin: e("SUPER_BROWSER_OPENCLI", file.opencli?.bin || "/opt/homebrew/bin/opencli"),
    windowAdapters: new Set(file.opencli?.windowAdapters || [
      "barchart", "twitter", "youtube", "bloomberg", "web", "google", "reddit", "instagram", "facebook"]),
    cloakPython: e("SUPER_BROWSER_CLOAK_PY", file.cloak?.python || "/Volumes/disco1tb/tools/scraping/.venv/bin/python3"),
    cloakMaxBytes: Number(e("SUPER_BROWSER_MAX_HTML", file.cloak?.maxHtmlBytes || 500000)),
    searxngUrl: e("SUPER_BROWSER_SEARXNG_URL", file.searxng?.url || "http://localhost:8081"),
    defaultSession: e("SUPER_BROWSER_SESSION", file.browser?.defaultSession || "mcp-main"),
    timeoutMs: Number(e("SUPER_BROWSER_TIMEOUT_MS", file.cloak?.timeoutMs || 45000)),
  };
}
const CFG = loadConfig();

/** Executa opencli <args...> --format json e devolve JSON parseado.
 *  --window background: só para adapters Chrome (whitelist no config).
 *  stdio ignore: o opencli não herda o stdin do MCP. */
function oc(args, { timeout = CFG.timeoutMs } = {}) {
  const full = CFG.windowAdapters.has(args[0]) ? [...args, "--window", "background", "--format", "json"]
                                               : [...args, "--format", "json"];
  try {
    const out = execFileSync(CFG.opencliBin, full, {
      timeout, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (e) {
    const msg = (e.stdout || e.message || "").toString().trim();
    try { return JSON.parse(msg); } catch { return { ok: false, error: msg.slice(0, 300) }; }
  }
}

const server = new McpServer({ name: "super-browser", version: "1.1.0" });

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

// ---- AUTOMAÇÃO browser interativa (fill/click/type/select/... no Chrome bridge).
//      Cobre os use cases que faltavam: preencher formulários, clicar, submetir.
//      action mapeia 1:1 para `opencli browser <action>` (36 comandos).
//      NOTA: `opencli browser` usa a SUA convenção de opções (--window background
//      --format json NÃO são aceites como nos adapters) → executor dedicado. ----
const BROWSER_ACTIONS = {
  open: { url: "string" }, state: {}, extract: {}, screenshot: { path: "string" },
  click: { target: "string" }, type: { target: "string", text: "string" },
  fill: { target: "string", text: "string" }, select: { target: "string", option: "string" },
  keys: { key: "string" }, scroll: { direction: "string" },
  wait: { type: "string", value: "string" }, eval: { js: "string" },
  find: { selector: "string" }, get: {}, frames: {}, console: {}, network: {},
  close: {}, tab: { action: "string" }, screenshot: { path: "string" },
};
const ACTIONS_LIST = Object.keys(BROWSER_ACTIONS);
// argumentos posicionais (1:1 para a ordem do opencli browser) vs flags (--k v)
const POS_ARGS = new Set(["target", "text", "option", "direction", "key", "js", "url", "path", "selector", "type", "value", "files"]);
// Sessão browser persistente por defeito (stateful): a navegação é SEQUENCIAL
// (open → find → fill → click → wait → extract). Se fosse stateless, cada ação
// abria um browser novo e perdia o contexto da página. O opencli browser exige
// <session> — usamos uma fixa (config browser.defaultSession) para a UI/agente.
const DEFAULT_SESSION = CFG.defaultSession;
function browserExec(action, args, session) {
  const cmd = [action];
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (POS_ARGS.has(k)) cmd.push(String(v));
    else cmd.push("--" + k, String(v));
  }
  const out = execFileSync(CFG.opencliBin, ["browser", session, ...cmd], {
    timeout: CFG.timeoutMs, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  try { return JSON.parse(out); } catch { return { raw: out.slice(0, 2000) }; }
}
server.tool("browser_act", `Executa uma ação de automação browser no Chrome bridge autenticado. Ações: ${ACTIONS_LIST.join(", ")}. Exemplos: fill (preencher formulário), click, type, select (dropdown), upload, keys, wait, eval, screenshot. STATE-FUL por defeito (sessão persistente "mcp-main"): open → fill → click funcionam em sequência na MESMA página. Para uma sessão isolada, passar session diferente.`,
  { action: z.string().describe(`Ação: ${ACTIONS_LIST.join(" | ")}`), args: z.record(z.any()).optional().describe("Argumentos da ação (ver schema de cada ação)"), session: z.string().optional().describe("Nome da sessão browser (default mcp-main; usar diferente para isolamento)") },
  async ({ action, args = {}, session = DEFAULT_SESSION }) => {
    if (!BROWSER_ACTIONS[action]) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Ação inválida: ${action}. Disponíveis: ${ACTIONS_LIST.join(", ")}` }) }] };
    try {
      const d = browserExec(action, args, session);
      return { content: [{ type: "text", text: JSON.stringify(d) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
    }
  });

// ---- Scraping stealth (CloakBrowser — passa Cloudflare/anti-bot) ----
const CLOAK_SCRIPT = (url, maxBytes) => `
import asyncio, cloakbrowser, json
async def main():
    browser = await cloakbrowser.launch_async(headless=True)
    page = await browser.new_page()
    await page.goto(${JSON.stringify(url)}, timeout=25000, wait_until="domcontentloaded")
    html = await page.content()
    title = await page.title()
    await browser.close()
    print(json.dumps({"ok": True, "url": ${JSON.stringify(url)}, "title": title, "len": len(html), "html": html[:${maxBytes}]}))
asyncio.run(main())
`;
server.tool("scrape_stealth", "Scraping stealth via CloakBrowser — passa Cloudflare/anti-bot que o curl/opencli falham (403). Devolve HTML renderizado completo.",
  { url: z.string().describe("URL completo") },
  async ({ url }) => {
    try {
      const out = execFileSync(CFG.cloakPython, ["-c", CLOAK_SCRIPT(url, CFG.cloakMaxBytes)], {
        timeout: CFG.timeoutMs, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
      const d = JSON.parse(out.trim());
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, title: d.title, len: d.len, url: d.url }) }] };
    } catch (e) {
      const msg = (e.stdout || e.message || "").toString().trim();
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: msg.slice(0, 200) }) }] };
    }
  });

// ---- Web search multi-motor (searxng) ----
server.tool("web_search", "Pesquisa web multi-motor (searxng).",
  { query: z.string().describe("Query"), limit: z.number().optional() },
  async ({ query, limit = 5 }) => {
    const res = await fetch(`${CFG.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`);
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
      ok: true, bridge_auth: bridge && bridge.logged_in ? "logged_in" : "unknown",
      version: "1.1.0", time: new Date().toISOString(),
    }) }] };
  });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((e) => { console.error("[super-browser-mcp] fatal:", e.message); process.exit(1); });

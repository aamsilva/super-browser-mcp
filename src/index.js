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
 *  Resiliência: se o adapter rejeitar --window (ex: google news usa API,
 *  google search usa browser — inconsistente dentro do mesmo adapter),
 *  faz retry sem o flag. stdio ignore: o opencli não herda o stdin do MCP. */
function oc(args, { timeout = CFG.timeoutMs } = {}) {
  const withWindow = CFG.windowAdapters.has(args[0]);
  const attempt = (win) => execFileSync(CFG.opencliBin, win ? [...args, "--window", "background", "--format", "json"]
                                                           : [...args, "--format", "json"], {
    timeout, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const out = attempt(withWindow);
    return JSON.parse(out);
  } catch (e) {
    // se falhou com --window e o adapter está na whitelist → retry sem flag
    if (withWindow && !/unknown option '--window'/.test((e.stdout || e.message || "").toString())) {
      try { return JSON.parse(attempt(true)); } catch { /* fallthrough */ }
    }
    try { return JSON.parse(attempt(false)); } catch {
      const msg = (e.stdout || e.message || "").toString().trim();
      try { return JSON.parse(msg); } catch { return { ok: false, error: msg.slice(0, 300) }; }
    }
  }
}

const server = new McpServer({ name: "super-browser", version: "1.1.0" });

// ---- Cache TTL simples (elimina o spawn do opencli para dados estáveis 60s).
//      ponytail: Map + timestamp, sem lib. Cache de 60s para dados de mercado
//      (quotes/options/crypto/defi são estáveis nessa janela). ----
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < (ttlMs || CACHE_TTL_MS)) return hit.data;
  const data = await fn();
  cache.set(key, { ts: Date.now(), data });
  // limpeza simples: evita crescimento infinito (ponytail: sem lib, per-entry TTL)
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
  }
  return data;
}
async function cachedOc(key, args) {
  return cached(key, null, () => oc(args));
}

// ---- Fetch direto às APIs públicas (elimina o spawn do opencli para dados
//      PUBLIC puros). O opencli continua como fonte de verdade para auth/adapters
//      complexos (barchart, twitter, web, browser). Fallback: se a API falhar,
//      usa o opencli (resiliência). ----
async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
function normalizeBinance(raw, pair) {
  return [{
    symbol: pair, price: raw.lastPrice, change: raw.priceChange,
    changePct: raw.priceChangePercent, high: raw.highPrice, low: raw.lowPrice,
    volume: raw.volume, quoteVolume: raw.quoteVolume,
  }];
}
function normalizeDefi(raw, limit) {
  return raw.slice(0, limit).map(p => ({
    slug: p.slug, name: p.name, tvl: p.tvl, mcap: p.mcap, chains: (p.chains || []).slice(0, 5),
    change_1d: p.change_1d, change_7d: p.change_7d, symbol: p.symbol,
  }));
}

// ---- Search em sites específicos (cheatsheet UC2/UC3/UC10/UC11/UC12) ----
// Tool única e genérica: site + comando + query. Cobre youtube search/feed,
// twitter trending/timeline, google news/search/trends, bookmarks, etc.
// A lista de sites vem de opencli list (adapter-first).
server.tool("site_search", "Pesquisa num site específico via opencli (adapter). Sites: youtube (search/feed/history/subscriptions), twitter (trending/timeline/search/bookmarks), google (news/search/trends), reddit (hot/search), bbc (news), hackernews (top/best). Uso: site + comando + query (query opcional conforme o comando).",
  { site: z.string().describe("Site (ex: youtube, twitter, google, reddit, bbc, hackernews)"), command: z.string().describe("Comando do site (ex: search, trending, timeline, news, top)"), query: z.string().optional().describe("Query (para comandos de search)"), limit: z.number().optional() },
  async ({ site, command, query, limit = 5 }) => {
    const args = [site, command];
    if (query) args.push(query);
    if (limit) args.push("--limit", String(limit));
    const d = await cachedOc(`site:${site}:${command}:${query || ""}`, args);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

// ---- Finance / Trading (subskill trading-search) ----
server.tool("finance_quote", "Cotações e dados de ações (barchart).",
  { symbol: z.string().describe("Ticker (ex: NVDA)") },
  async ({ symbol }) => {
    // cache TTL 60s: o barchart via opencli é lento (~2-9s); cache elimina o spawn
    const d = await cachedOc(`quote:${symbol}`, ["barchart", "quote", symbol]);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

server.tool("finance_options", "Cadeia de opções + greeks + IV (barchart).",
  { symbol: z.string().describe("Ticker (ex: NVDA)") },
  async ({ symbol }) => {
    const d = await cachedOc(`options:${symbol}`, ["barchart", "options", symbol]);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

server.tool("finance_crypto", "Preço crypto (binance).",
  { pair: z.string().describe("Par (ex: BTCUSDT)") },
  async ({ pair }) => {
    try {
      // HTTP direto à API pública da Binance (sem spawn opencli ~1.5s → ~0.2s)
      const d = await cached(`binance:${pair}`, null, async () => {
        const raw = await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
        return normalizeBinance(raw, pair);
      });
      return { content: [{ type: "text", text: JSON.stringify(d) }] };
    } catch (e) {
      // fallback: opencli (fonte de verdade) se a API pública falhar
      const d = await cachedOc(`binance:${pair}`, ["binance", "price", pair]);
      return { content: [{ type: "text", text: JSON.stringify(d) }] };
    }
  });

server.tool("finance_defi", "Top DeFi por TVL (defillama).",
  { limit: z.number().optional().describe("Quantos protocolos") },
  async ({ limit = 5 }) => {
    try {
      const d = await cached(`defi:${limit}`, null, async () => {
        const raw = await fetchJson("https://api.llama.fi/protocols");
        return normalizeDefi(raw, limit);
      });
      return { content: [{ type: "text", text: JSON.stringify(d) }] };
    } catch (e) {
      const d = await cachedOc(`defi:${limit}`, ["defillama", "protocols", "--limit", String(limit)]);
      return { content: [{ type: "text", text: JSON.stringify(d) }] };
    }
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
    // web read usa --url (flag, não posicional) e não aceita --window
    const d = await cached(`browse:${url}`, null, () => oc(["web", "read", "--url", url]));
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
function browserExec(action, args, session, windowMode) {
  const cmd = [action];
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (POS_ARGS.has(k)) cmd.push(String(v));
    else cmd.push("--" + k, String(v));
  }
  const flags = ["browser", session, ...cmd];
  if (windowMode) flags.push("--window", windowMode);
  const out = execFileSync(CFG.opencliBin, flags, {
    timeout: CFG.timeoutMs, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  try { return JSON.parse(out); } catch { return { raw: out.slice(0, 2000) }; }
}
server.tool("browser_act", `Executa uma ação de automação browser no Chrome bridge autenticado. Ações: ${ACTIONS_LIST.join(", ")}. Exemplos: fill (preencher formulário), click, type, select (dropdown), upload, keys, wait, eval, screenshot. STATE-FUL por defeito (sessão persistente "mcp-main"): open → fill → click funcionam em sequência na MESMA página. Para uma sessão isolada, passar session diferente. AUTH ASSISTIDA: passar window:"foreground" abre a página VISÍVEL no Chrome real do utilizador — para login manual (o utilizador preenche, o agente espera com action:"wait" e depois valida com health/whoami). window:"background" (default) é invisível.`,
  { action: z.string().describe(`Ação: ${ACTIONS_LIST.join(" | ")}`), args: z.record(z.any()).optional().describe("Argumentos da ação (ver schema de cada ação)"), session: z.string().optional().describe("Nome da sessão browser (default mcp-main; usar diferente para isolamento)"), window: z.string().optional().describe("Modo da janela: background (default, invisível) ou foreground (VISÍVEL — para auth manual pelo utilizador)") },
  async ({ action, args = {}, session = DEFAULT_SESSION, window: windowMode }) => {
    if (!BROWSER_ACTIONS[action]) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Ação inválida: ${action}. Disponíveis: ${ACTIONS_LIST.join(", ")}` }) }] };
    try {
      const d = browserExec(action, args, session, windowMode);
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
      version: "1.2.0", time: new Date().toISOString(),
    }) }] };
  });

// ---- Auth status (replica opencli auth status — sessões autenticadas por site) ----
server.tool("auth_status", "Estado de autenticação por site (opencli auth status). Lista quais sites têm sessão ativa no Chrome bridge (logged_in/not_logged_in).",
  {},
  async () => {
    const out = execFileSync(CFG.opencliBin, ["auth", "status", "--format", "json"], {
      timeout: CFG.timeoutMs, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const d = JSON.parse(out);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

// ---- Auth check FIÁVEL (navega + verifica sinais DOM/redirect).
//      O whoami do opencli NÃO é fidedigno (§OpencliAuthParser): reddit/instagram
//      diziam AUTH_REQUIRED mas estavam logados, e vice-versa. Estratégia:
//      navegar para uma página SÓ-autenticada e verificar se redireciona para
//      /login. Se carrega → autenticado. Fiável porque o servidor decide.
const AUTH_PROBES = {
  reddit: "https://www.reddit.com/settings/",
  instagram: "https://www.instagram.com/accounts/edit/",
  github: "https://github.com/settings/profile",
  twitter: "https://x.com/settings/account",
  youtube: "https://www.youtube.com/account",
  amazon: "https://www.amazon.com/gp/css/homepage.html",
  generic: "",
};
server.tool("auth_check", "Valida autenticação por NAVEGAÇÃO (fiável, não usa whoami): abre uma página só-autenticada do site e verifica se redireciona para login. Sites: reddit, instagram, github, twitter, youtube, amazon. Devolve {authenticated, url, redirected}. Isto substitui o whoami do opencli (não fidedigno).",
  { site: z.string().describe("Site: reddit | instagram | github | twitter | youtube | amazon") },
  async ({ site }) => {
    const url = AUTH_PROBES[site];
    if (!url) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Site desconhecido: ${site}. Disponíveis: ${Object.keys(AUTH_PROBES).join(", ")}` }) }] };
    const session = `authcheck-${site}-${Date.now()}`;
    try {
      browserExec("open", { url }, session, "background");
      await new Promise(r => setTimeout(r, 4000));
      const st = browserExec("eval", { js: `(() => { const u = location.href; return { url: u, redirected: /\\/(login|accounts\\/login|signin)(\\?|\\/|$)/.test(u) }; })()` }, session);
      // browserExec devolve JSON parseado (eval devolve objeto) ou {raw: texto}
      const d = st.raw ? JSON.parse(st.raw) : st;
      const urlFinal = d.url || "";
      const redirected = d.redirected === true || /\/login/.test(urlFinal);
      const authenticated = !redirected && urlFinal.length > 0;
      try { browserExec("close", {}, session); } catch {}
      return { content: [{ type: "text", text: JSON.stringify({ site, authenticated, url: urlFinal, redirected }) }] };
    } catch (e) {
      try { browserExec("close", {}, session); } catch {}
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
    }
  });

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((e) => { console.error("[super-browser-mcp] fatal:", e.message); process.exit(1); });

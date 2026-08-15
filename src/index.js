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
const os = require("os");

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
    cloakMaxBytes: Number(e("SUPER_BROWSER_MAX_HTML", file.cloak?.maxHtmlBytes || 2000000)),
    searxngUrl: e("SUPER_BROWSER_SEARXNG_URL", file.searxng?.url || "http://localhost:8081"),
    defaultSession: e("SUPER_BROWSER_SESSION", file.browser?.defaultSession || "mcp-main"),
    maxTabs: Number(e("SUPER_BROWSER_MAX_TABS", file.browser?.maxTabs || 10)),
    autoCloseRead: e("SUPER_BROWSER_AUTOCLOSE", String(file.browser?.autoCloseRead ?? true)) !== "false",
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
    timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
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
server.tool("site_search", "Pesquisa num site específico via opencli (adapter). Sites: youtube (search/feed/history/subscriptions/transcript), twitter (trending/timeline/search/bookmarks), google (news/search/trends), reddit (hot/search), bbc (news), hackernews (top/best), defillama (protocols/protocol), linkedin (inbox/posts/people-search). Uso: site + comando + query. Para comandos POSICIONAIS (defillama protocol <slug>, youtube transcript <url>) usar arg (não query).",
  { site: z.string().describe("Site (ex: youtube, twitter, google, reddit, bbc, hackernews, defillama, linkedin)"), command: z.string().describe("Comando do site (ex: search, trending, timeline, news, top, protocol, transcript, inbox)"), query: z.string().optional().describe("Query (para comandos de search)"), arg: z.string().optional().describe("Argumento posicional para comandos como protocol/transcript (ex: slug, URL de video)"), limit: z.number().optional() },
  async ({ site, command, query, arg, limit = 5 }) => {
    const args = [site, command];
    if (arg) args.push(arg);
    else if (query) args.push(query);
    // --limit só para comandos de listagem (search/news/trending/hot/top/protocols);
    // comandos posicionais (protocol, transcript, inbox) rejeitam a flag.
    const LISTING_CMDS = new Set(["search", "news", "trending", "hot", "top", "best", "protocols", "timeline", "feed", "subscriptions", "history"]);
    if (limit && LISTING_CMDS.has(command)) args.push("--limit", String(limit));
    const d = await cachedOc(`site:${site}:${command}:${arg || query || ""}`, args);
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
server.tool("browser_browse", "Navega para qualquer URL e extrai conteúdo (markdown). Devolve o conteúdo REAL do artigo. FALLBACK: se o opencli web.read falhar/timeout (bridge lento), usa CloakBrowser (stealth).",
  { url: z.string().describe("URL completo") },
  async ({ url }) => {
    // web read usa --url (flag, não posicional) e não aceita --window.
    // O opencli guarda o markdown em web-articles/<site>/<site>.md (cwd ou ~).
    // Fallback (15-Ago, lição T2): se o bridge Chrome está lento, o web.read
    // pendura — usar CloakBrowser (stealth, não depende do bridge) com timeout curto.
    const d = await cached(`browse:${url}`, null, () => {
      try {
        return oc(["web", "read", "--url", url], { timeout: 15000 });
      } catch {
        return null; // sinaliza fallback
      }
    });
    let result = d;
    if (!d || d.ok === false) {
      // fallback: CloakBrowser (stealth, sem bridge)
      const stealth = await scrapeStealth(url);
      if (stealth.ok) result = { ...stealth, fallback: "cloakbrowser" };
      else result = { ok: false, error: "web.read falhou e CloakBrowser também", detail: stealth.error };
    }
    try {
      const meta = Array.isArray(result) ? result[0] : result;
      const saved = meta?.saved;
      if (saved && !result.html) {
        // candidatos de path: cwd, home, dir do projeto
        const candidates = [path.resolve(saved), path.join(os.homedir(), saved), path.join(__dirname, "..", saved)];
        for (const p of candidates) {
          if (fs.existsSync(p)) {
            const content = fs.readFileSync(p, "utf8").slice(0, 50000); // cap 50KB
            result = { ...meta, content, content_len: content.length, saved: p };
            break;
          }
        }
      }
    } catch { /* devolve metadata se não conseguir ler */ }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
    // tab: sub-comando posicional (tab new <url>, tab list, tab close <targetId>)
    if (action === "tab" && (k === "action" || k === "url")) { cmd.push(String(v)); continue; }
    if (POS_ARGS.has(k)) cmd.push(String(v));
    else cmd.push("--" + k, String(v));
  }
  const flags = ["browser", session, ...cmd];
  if (windowMode) flags.push("--window", windowMode);
  const out = execFileSync(CFG.opencliBin, flags, {
    timeout: CFG.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  try { return JSON.parse(out); } catch { return { raw: out.slice(0, 2000) }; }
}
server.tool("browser_act", `Executa uma ação de automação browser no Chrome bridge autenticado. Ações: ${ACTIONS_LIST.join(", ")}. Exemplos: fill (preencher formulário), click, type, select (dropdown), upload, keys, wait, eval, screenshot. STATE-FUL por defeito (sessão persistente "mcp-main"): open → fill → click funcionam em sequência na MESMA página. Para uma sessão isolada, passar session diferente. AUTH ASSISTIDA: passar window:"foreground" abre a página VISÍVEL no Chrome real do utilizador — para login manual (o utilizador preenche, o agente espera com action:"wait" e depois valida com health/whoami). window:"background" (default) é invisível.`,
  { action: z.string().describe(`Ação: ${ACTIONS_LIST.join(" | ")}`), args: z.record(z.any()).optional().describe("Argumentos da ação (ver schema de cada ação)"), session: z.string().optional().describe("Nome da sessão browser (default mcp-main; usar diferente para isolamento)"), window: z.string().optional().describe("Modo da janela: background (default, invisível) ou foreground (VISÍVEL — para auth manual pelo utilizador)") },
  async ({ action, args = {}, session = DEFAULT_SESSION, window: windowMode }) => {
    if (!BROWSER_ACTIONS[action]) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Ação inválida: ${action}. Disponíveis: ${ACTIONS_LIST.join(", ")}` }) }] };
    try {
      // GESTÃO DE RECURSOS NATIVA (regra user 15-Ago): limite de tabs por sessão (LRU).
      // Ao abrir tab, se exceder maxTabs, fechar a mais antiga — nunca acumular.
      if (action === "tab" && args.action === "new") {
        try {
          const list = browserExec("tab", { action: "list" }, session);
          const count = (String(list).match(/"index"/g) || []).length;
          if (count >= CFG.maxTabs) {
            // fechar a tab mais antiga (primeira da lista) antes de abrir a nova
            try { browserExec("tab", { action: "close", index: "0" }, session); } catch { /* LRU best-effort */ }
          }
        } catch { /* se não conseguir listar, abrir mesmo assim */ }
      }
      const d = browserExec(action, args, session, windowMode);
      // AUTO-CLOSE (regra user 15-Ago): ações de LEITURA consomem a info e fecham
      // a tab IMEDIATAMENTE (minimizar tempo aberto = memória). Ações interativas
      // (open/fill/click/type/wait) NÃO fecham — o agente precisa da sessão ativa.
      const READ_ACTIONS = new Set(["extract", "state", "eval", "screenshot", "get", "tab"]);
      if (READ_ACTIONS.has(action) && CFG.autoCloseRead) {
        try { browserExec("close", {}, session); } catch { /* fechar best-effort */ }
        // VERIFICAÇÃO END-TO-END (lição user 15-Ago): após fechar, confirmar 0 tabs
        // reais (não só fechar a sessão — garantir que o Chrome físico ficou limpo).
        let remaining = "?";
        try {
          const check = browserExec("tab", { action: "list" }, session);
          remaining = String(check).match(/"index"/g) ? String(check).match(/"index"/g).length : 0;
        } catch { remaining = 0; }
        return { content: [{ type: "text", text: JSON.stringify({ ...d, auto_closed: true, tabs_remaining: remaining }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(d) }] };
    } catch (e) {
      // mesmo em erro, fechar a tab (não deixar órfãos)
      try { browserExec("close", {}, session); } catch {}
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
    }
  });

// ---- agent-browser (headless, sessões próprias — cobre amazon/booking/polymarket
//      onde o opencli não tem sessão). As sessões vivem em ~/.agent-browser/<nome>.
//      agent-browser usa a SUA convenção (--session-name, snapshot/refs). ----
const AGENT_BIN = "/opt/homebrew/bin/agent-browser";
function agentExec(args, { timeout = CFG.timeoutMs } = {}) {
  const out = execFileSync(AGENT_BIN, args, {
    timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return out;
}
server.tool("browser_agent", "Automação browser via agent-browser (headless, sessões próprias). Cobre sites onde o opencli NÃO tem sessão (ex: amazon, booking, polymarket — sessões em ~/.agent-browser/<nome>). Ações: open (abrir URL com sessão), snapshot (ver estado da página), fill/type (preencher), click, press (teclas), scroll, close (fechar sessão — SEMPRE usar após open para não deixar órfãos PPID=1). STATE-FUL por sessão: usar session=<nome> (ex: amazon) para reutilizar cookies persistidos.",
  { action: z.string().describe("Ação: open | snapshot | fill | type | click | press | scroll | close"), url: z.string().optional().describe("URL (para action:open)"), selector: z.string().optional().describe("Seletor CSS ou @ref (para click/fill/type)"), text: z.string().optional().describe("Texto (para fill/type)"), key: z.string().optional().describe("Tecla (para press, ex: Enter)"), session: z.string().optional().describe("Sessão agent-browser (ex: amazon, booking1, polymarket, default)") },
  async ({ action, url, selector, text, key, session = "default" }) => {
    try {
      let out;
      if (action === "open") {
        out = agentExec(["open", url, "--session-name", session]);
      } else if (action === "snapshot") {
        out = agentExec(["snapshot", "--session-name", session]);
      } else if (action === "fill") {
        out = agentExec(["fill", selector, text, "--session-name", session]);
      } else if (action === "type") {
        out = agentExec(["type", selector, text, "--session-name", session]);
      } else if (action === "click") {
        out = agentExec(["click", selector, "--session-name", session]);
      } else if (action === "press") {
        out = agentExec(["press", key, "--session-name", session]);
      } else if (action === "scroll") {
        out = agentExec(["scroll", text || "down", "--session-name", session]);
      } else if (action === "close") {
        out = agentExec(["close", "--session-name", session]);
      } else {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Ação inválida: ${action}. Disponíveis: open, snapshot, fill, type, click, press, scroll, close` }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, output: out.slice(0, 20000) }) }] };
    } catch (e) {
      const msg = (e.stdout || e.message || "").toString().trim();
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: msg.slice(0, 300) }) }] };
    }
  });
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
async function scrapeStealth(url) {
  try {
    const out = execFileSync(CFG.cloakPython, ["-c", CLOAK_SCRIPT(url, CFG.cloakMaxBytes)], {
      timeout: CFG.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const d = JSON.parse(out.trim());
    const html = d.html || "";
    return { ok: true, title: d.title, len: d.len, url: d.url, html, html_len: html.length };
  } catch (e) {
    const msg = (e.stdout || e.message || "").toString().trim();
    return { ok: false, error: msg.slice(0, 200) };
  }
}
server.tool("scrape_stealth", "Scraping stealth via CloakBrowser — passa Cloudflare/anti-bot que o curl/opencli falham (403). Devolve HTML renderizado completo.",
  { url: z.string().describe("URL completo") },
  async ({ url }) => {
    const d = await scrapeStealth(url);
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

// ---- Web search: Google (opencli) PRIMÁRIO + searxng fallback ----
// Decisão 15-Ago [VERIFICADO]: google via opencli (COOKIE autenticado) dá 3 results
// em 2.7s sem CAPTCHA; searxng degradou (brave rate-limit, ddg timeout, startpage
// CAPTCHA) -> 0 results. Google primeiro, searxng fallback. Cada query google abre
// tab no Chrome bridge — fechar após a operação para reclamar memória (regra user).
server.tool("web_search", "Pesquisa web: Google (opencli, autenticado) PRIMÁRIO + searxng fallback multi-engine. Devolve resultados normalizados; sinaliza degraded se ambas falharem.",
  { query: z.string().describe("Query"), limit: z.number().optional() },
  async ({ query, limit = 5 }) => {
    // 1. Google via opencli (sessão COOKIE autenticada) — fiable, sem CAPTCHA
    try {
      const g = oc(["google", "search", query, "--limit", String(limit)]);
      const items = (Array.isArray(g) ? g : []).map(r => ({
        title: r.title || "", url: r.url || "", snippet: (r.snippet || r.content || "").slice(0, 200),
      }));
      if (items.length > 0) return { content: [{ type: "text", text: JSON.stringify({ engine: "google", results: items }) }] };
    } catch { /* google falhou -> searxng fallback */ }
    // 2. Searxng fallback (multi-engine)
    try {
      const res = await fetch(`${CFG.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json`);
      const d = await res.json();
      const items = (d.results || []).slice(0, limit).map(r => ({
        title: r.title, url: r.url, snippet: (r.content || "").slice(0, 200),
      }));
      if (items.length > 0) return { content: [{ type: "text", text: JSON.stringify({ engine: "searxng", results: items }) }] };
      const degraded = Array.isArray(d.unresponsive_engines) && d.unresponsive_engines.length > 0 || !d.results;
      if (degraded) return { content: [{ type: "text", text: JSON.stringify({ ok: false, degraded: true, error: "google+searxng sem resultados", engine: "searxng" }) }] };
    } catch {}
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, degraded: true, error: "google+searxng ambos falharam" }) }] };
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
      timeout: CFG.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
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

// ---- Logging central de TODAS as chamadas tools/call (qualquer fonte: opencode,
//      VS Code, Antigravity, webui, VPS). O serve_capabilities só logava as
//      chamadas que passavam por ele (webui/API) — as chamadas diretas via stdio
//      (opencode T1/T2/T3) NÃO eram logadas (gap provado 15-Ago). ----
let db = null;
try {
  db = new (require("node:sqlite").DatabaseSync)(path.join(__dirname, "..", "capabilities_state.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=3000");
  db.exec("CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, ts REAL, tool TEXT, ok INTEGER, latency_ms REAL, error TEXT, caller TEXT, method TEXT, params TEXT, result TEXT, source TEXT, result_type TEXT, result_summary TEXT)");
} catch { db = null; }
function mcpLogCall(tool, ok, ms, error, params, result) {
  if (!db) return;
  try {
    const summary = (() => { try { const j = JSON.parse(result || "{}"); if (Array.isArray(j)) return j.length + " itens"; if (j.error) return "erro: " + String(j.error).slice(0, 60); if (j.authenticated !== undefined) return "authenticated=" + j.authenticated; if (j.title && j.len) return j.title.slice(0, 30) + " (" + j.len + "B)"; if (j.price) return "price=" + j.price; if (j.ok !== undefined) return "ok=" + j.ok; return Object.keys(j).slice(0, 3).map(k => k + "=" + String(j[k]).slice(0, 15)).join(", "); } catch { return (result || "").slice(0, 80); } })();
    db.prepare("INSERT INTO calls (ts, tool, ok, latency_ms, error, caller, method, params, result, source, result_type, result_summary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      Date.now() / 1000, tool, ok ? 1 : 0, ms, (error || "").slice(0, 300), "mcp-stdio", "mcp-direct", (params || "").slice(0, 300), (result || "").slice(0, 2000), "opencode", ok ? "ok" : "error", String(summary).slice(0, 120));
  } catch { /* logging nunca deve partir o MCP */ }
}
// Interceptar tools/call — registar TODAS as chamadas independentemente da fonte.
const _origCallTool = server.executeToolHandler ? server.executeToolHandler.bind(server) : null;
if (_origCallTool) {
  server.executeToolHandler = async (tool, args, extra) => {
    const t0 = Date.now();
    // nome: do tool object (campo variável) ou lookup no registry
    const name = (tool && (tool.name || (tool.tool && tool.tool.name))) ||
      (server._registeredTools && Object.keys(server._registeredTools).find(k => server._registeredTools[k] === tool)) || "?";
    try {
      const res = await _origCallTool(tool, args, extra);
      const txt = (res && res.content && res.content[0] && res.content[0].text) || "";
      mcpLogCall(name, !txt.startsWith('{"ok":false'), Date.now() - t0, "", JSON.stringify(args), txt);
      return res;
    } catch (e) {
      mcpLogCall(name, false, Date.now() - t0, e.message, JSON.stringify(args), "");
      throw e;
    }
  };
}
main().catch((e) => { console.error("[super-browser-mcp] fatal:", e.message); process.exit(1); });

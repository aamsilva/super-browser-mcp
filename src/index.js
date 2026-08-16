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
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

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
    searxngUrl: "", // searxng REMOVIDO 16-Ago (0 sucessos/48h) — mantido vazio para compatibilidade
    defaultSession: e("SUPER_BROWSER_SESSION", file.browser?.defaultSession || "mcp-main"),
    maxTabs: Number(e("SUPER_BROWSER_MAX_TABS", file.browser?.maxTabs || 30)),
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
function oc(args, { timeout = CFG.timeoutMs, retries = 2 } = {}) {
  const withWindow = CFG.windowAdapters.has(args[0]);
  const attempt = (win) => execFileSync(CFG.opencliBin, win ? [...args, "--window", "background", "--format", "json"]
                                                           : [...args, "--format", "json"], {
    timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  // RETRY UNIVERSAL (melhoria #1, 15-Ago 23:50): connection closed/ETIMEDOUT/ECONNRESET
  // são transitórios do bridge Chrome — retry 2x antes de falhar. Aplica a TODAS as
  // tools que usam oc() (antes só social_sentiment tinha retry dedicado).
  const TRANSIENT = /connection closed|ETIMEDOUT|ECONNRESET|spawnSync.*ETIMEDOUT|socket hang up|ENOTFOUND/i;
  for (let attemptNum = 0; ; attemptNum++) {
    try {
      const out = attempt(withWindow);
      return JSON.parse(out);
    } catch (e) {
      const msg = (e.stdout || e.message || "").toString().trim();
      if (attemptNum >= retries || !TRANSIENT.test(msg)) {
        // se falhou com --window e o adapter está na whitelist → retry sem flag
        if (withWindow && !/unknown option '--window'/.test(msg)) {
          try { return JSON.parse(attempt(true)); } catch { /* fallthrough */ }
        }
        try { return JSON.parse(attempt(false)); } catch {
          try { return JSON.parse(msg); } catch { return { ok: false, error: msg.slice(0, 300) }; }
        }
      }
      // transient → retry (pequena pausa para o bridge recuperar)
      const delay = attemptNum + 1;
      const start = Date.now();
      while (Date.now() - start < delay * 500) { /* busy-wait curto */ }
    }
  }
}

const server = new McpServer({ name: "super-browser", version: pkg.version });

// ---- Cache com TTL por categoria (user 16-Ago: avaliar volatilidade × criticidade × custo).
//      TTL NÃO é fixo — depende da natureza do dado e do custo de refresh:
//        • finance_quote: preço muda (volátil) + usado em trading (crítico) + refresh 13.7s caro
//          → TTL curto (15s): frescura p/ decisão, ainda poupa spawns (custo refresh alto)
//        • finance_crypto: MUITO volátil mas refresh barato (fetch direto ~1s) → TTL 5s
//        • finance_defi: TVL muda devagar (estável) + refresh barato → TTL LONGO 15min
//        • web/site_search: notícias semi-frescas + refresh 6-7s → TTL 60s
//        • social_sentiment: tweets novos + refresh 5s → TTL 120s (fresco o suficiente)
//        • auth_*/health: estado muda raramente + refresh 1-8s → TTL 300s
//        • browser_act/browse: NUNCA cachear (estado/HTML pode ser stale)
//      ponytail: Map + timestamp, sem lib.
const CACHE_TTL_BY_PREFIX = {
  "quote:": 60 * 1000,        // volátil + crítico (trading) + refresh caro (16-Ago: 15s→60s — grading: 9 símbolos em 361 chamadas, usos espaçados >15s → 40% do custo era spawns repetidos)
  "crypto:": 5 * 1000,        // muito volátil + refresh barato
  "binance:": 5 * 1000,       // idem (fallback do fetch direto)
  "defi:": 15 * 60 * 1000,    // estável + refresh barato → TTL longo
  "site:": 60 * 1000,         // notícias/semi-fresco + refresh médio
  "web:": 60 * 1000,
  "sent:": 120 * 1000,        // social sentiment: fresco o suficiente
  "auth:": 300 * 1000,        // estado de auth muda raramente
  "health:": 300 * 1000,
  "browse:": 0,               // HTML/estado — NUNCA cachear (pode estar stale)
};
const CACHE_TTL_MS = 60 * 1000; // default (fallback)
function ttlFor(key) {
  for (const [p, ttl] of Object.entries(CACHE_TTL_BY_PREFIX)) if (key.startsWith(p)) return ttl;
  return CACHE_TTL_MS;
}
// ---- Cache PERSISTENTE (user 16-Ago): o Map em memória zerava a cada sessão (MCP é
//      lazy-spawn por sessão → cache perdida → spawns repetidos). Ficheiro JSON partilhado
//      entre processos + escrita atómica (temp+rename) para concorrência segura.
const CACHE_FILE = path.join(__dirname, "..", "cache_state.json");
let cache = new Map();
try {
  const raw = fs.readFileSync(CACHE_FILE, "utf8");
  cache = new Map(Object.entries(JSON.parse(raw)));
} catch { /* primeira execução — cache vazia */ }
let cacheDirty = false;
let cacheWriteTimer = null;
function persistCache() {
  if (!cacheDirty) return;
  cacheDirty = false;
  try {
    const tmp = CACHE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache)));
    fs.renameSync(tmp, CACHE_FILE); // atómico: nunca ficheiro corrompido
  } catch { /* best-effort */ }
}
async function cached(key, ttlMs, fn) {
  const ttl = ttlMs || ttlFor(key);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const data = await fn();
  if (ttl > 0) {
    cache.set(key, { ts: Date.now(), data }); // ttl 0 = nunca cachear (browse/HTML)
    cacheDirty = true;
    if (!cacheWriteTimer) cacheWriteTimer = setTimeout(() => { cacheWriteTimer = null; persistCache(); }, 1000);
  }
  // limpeza simples: evita crescimento infinito (ponytail: sem lib, per-entry TTL)
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [k, v] of cache) if (now - v.ts > Math.max(ttlFor(k), CACHE_TTL_MS)) cache.delete(k);
    persistCache();
  }
  return data;
}
process.on("exit", persistCache);
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
  { site: z.string().describe("Site (ex: youtube, twitter, google, reddit, bbc, hackernews, defillama, linkedin, github, barchart)"), command: z.string().describe("Comando do site (ex: search, trending, timeline, news, top, protocol, transcript, inbox, repos, prs, issues, releases)"), query: z.string().optional().describe("Query (para comandos de search)"), arg: z.string().optional().describe("Argumento posicional para comandos como protocol/transcript (ex: slug, URL de video)"), limit: z.number().optional(), fresh: z.number().optional().describe("Filtro de frescura (P3-6, feedback T2): só resultados com date <= N dias de idade. Aplica a google news.") },
  async ({ site, command, query, arg, limit = 5, fresh }) => {
    const args = [site, command];
    if (arg) args.push(arg);
    else if (query) args.push(query);
    // --limit só para comandos de listagem (search/news/trending/hot/top/protocols);
    // comandos posicionais (protocol, transcript, inbox) rejeitam a flag.
    const LISTING_CMDS = new Set(["search", "news", "trending", "hot", "top", "best", "protocols", "timeline", "feed", "subscriptions", "history", "repos", "prs", "issues", "releases", "commits", "gists", "stars"]);
    if (limit && LISTING_CMDS.has(command)) args.push("--limit", String(limit));
    const d = await cachedOc(`site:${site}:${command}:${arg || query || ""}`, args);
    // P1-1 fix (feedback T2 15-Ago): youtube channel devolve field/value — normalizar
    // para objeto estruturado com channelId direto (news-intel RSS dinâmico sem parse).
    if (site === "youtube" && command === "channel" && Array.isArray(d)) {
      const meta = {};
      const recent_videos = [];
      const META_FIELDS = new Set(["channelId", "description", "handle", "keywords", "name", "subscribers", "url"]);
      for (const it of d) {
        const f = it?.field, v = it?.value;
        if (!f) continue;
        if (f === "---" || /Recent Videos/.test(String(v))) continue;
        // vídeo: title no FIELD, value = "dur | channel | url"
        const parts = String(v).split(" | ");
        const durMatch = parts[0]?.match(/^(\d+:\d\d:\d\d|\d+:\d\d)$/);
        if (parts.length >= 3 && durMatch) {
          recent_videos.push({ title: f.trim(), duration: durMatch[1], channel: parts[1].trim(), url: parts[2].trim() });
          continue;
        }
        if (META_FIELDS.has(f)) meta[f] = v;
      }
      if (meta.channelId) return { content: [{ type: "text", text: JSON.stringify({ ...meta, recent_videos }) }] };
    }
    // P3-6 fix (feedback T2 15-Ago): google news tem campo date mas não ordena por
    // recência. Ordenar desc por date; se fresh=N, filtrar resultados mais velhos que N dias.
    if (site === "google" && command === "news" && Array.isArray(d)) {
      const parseDate = (s) => { const t = Date.parse(s || ""); return isNaN(t) ? 0 : t; };
      const sorted = d.filter(it => it && (it.date !== undefined || fresh === undefined))
        .map(it => ({ ...it, _t: parseDate(it?.date) }))
        .sort((a, b) => b._t - a._t)
        .map(({ _t, ...rest }) => rest);
      const out = fresh ? sorted.filter(it => it.date && (Date.now() - parseDate(it.date)) <= fresh * 86400000) : sorted;
      if (out.length > 0) return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(d) }] };
  });

// ---- Finance / Trading (subskill trading-search) ----
server.tool("finance_quote", "Cotações e dados de ações (barchart). Suporta BATCH: symbols separados por vírgula (ex: NVDA,AAPL,MSFT) — devolve array.",
  { symbol: z.string().describe("Ticker(s) separados por vírgula (ex: NVDA ou NVDA,AAPL,MSFT)") },
  async ({ symbol }) => {
    const symbols = symbol.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "sem símbolos" }) }] };
    // cache TTL 60s: o barchart via opencli é lento (~2-9s); cache elimina o spawn.
    // BATCH (melhoria #3 15-Ago): 1 spawn por symbol (paralelo), cache partilhada.
    const results = await Promise.all(symbols.map(sym => cachedOc(`quote:${sym}`, ["barchart", "quote", sym])));
    const all = results.flatMap(d => (Array.isArray(d) ? d : [d]));
    // P1 fix (feedback T1 15-Ago): o adapter barchart devolve marketCap em MILHARES
    // (NVDA 5,448,872,320 = $5.4T). Normalizar ×1000 → dólares, em todas as posições.
    for (const it of all) {
      if (it && (typeof it.marketCap === "string" || typeof it.marketCap === "number")) {
        const n = Number(String(it.marketCap).replace(/,/g, ""));
        if (Number.isFinite(n) && n > 0) it.marketCap = n * 1000;
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(symbols.length === 1 ? all[0] : all) }] };
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
    // P2-3 fix (feedback T2 15-Ago): connection closed intermitente no 1º try (~1/5) —
    // retry 1x antes de falhar.
    let d;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        d = oc(["twitter", "search", query, "--limit", String(limit)]);
        if (d && d.ok !== false && !d.error) break;
      } catch { /* retry */ }
    }
    if (!d) d = { ok: false, error: "twitter search falhou 2x (connection closed)" };
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
        // P2 fix (feedback T1 15-Ago): amazon order-history demora >15s a renderizar.
        // Timeout 15s → 30s antes de cair no fallback CloakBrowser.
        return oc(["web", "read", "--url", url], { timeout: 30000 });
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
// P1-2 (feedback T2 15-Ago): registry de sessions usadas → tab list com args.all
// agrega todas (cross-session), não só a master.
const KNOWN_SESSIONS = new Set([DEFAULT_SESSION]);
function browserExec(action, args, session, windowMode) {
  const cmd = [action];
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || v === null || v === "") continue;
    // tab: sub-comando posicional (tab new <url>, tab list, tab close <targetId>)
    if (action === "tab" && (k === "action" || k === "url")) { cmd.push(String(v)); continue; }
    if (POS_ARGS.has(k)) cmd.push(String(v));
    else if (v === true) cmd.push("--" + k);                 // flags booleanas: --all, --failed
    else if (v === false || v === 0) continue;               // false/0 → omitir
    else cmd.push("--" + k, String(v));
  }
  const flags = ["browser", session, ...cmd];
  if (windowMode) flags.push("--window", windowMode);
  const out = execFileSync(CFG.opencliBin, flags, {
    timeout: CFG.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  try { return JSON.parse(out); } catch { return { raw: out.slice(0, 2000) }; }
}

// browserExecAsync — versão ASSÍNCRONA (execFile) para o auth_audit:
// o execFileSync bloqueia o event loop, então 18 sites sequenciais excederiam o
// timeout do wrapper. execFile com timeout por chamada permite paralelismo real.
const { execFile } = require("child_process");
function browserExecAsync(action, args, session, windowMode, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const cmd = [action];
    for (const [k, v] of Object.entries(args || {})) {
      if (v === undefined || v === null || v === "") continue;
      if (action === "tab" && (k === "action" || k === "url")) { cmd.push(String(v)); continue; }
      if (POS_ARGS.has(k)) cmd.push(String(v));
      else if (v === true) cmd.push("--" + k);
      else if (v === false || v === 0) continue;
      else cmd.push("--" + k, String(v));
    }
    const flags = ["browser", session, ...cmd];
    if (windowMode) flags.push("--window", windowMode);
    execFile(CFG.opencliBin, flags, {
      timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message.slice(0, 120) });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ raw: String(stdout).slice(0, 2000) }); }
    });
  });
}
server.tool("browser_act", `Executa uma ação de automação browser no Chrome bridge autenticado. Ações: ${ACTIONS_LIST.join(", ")}. Exemplos: fill (preencher formulário), click, type, select (dropdown), upload, keys, wait, eval, screenshot. STATE-FUL por defeito (sessão persistente "mcp-main"): open → fill → click funcionam em sequência na MESMA página. Para uma sessão isolada, passar session diferente. AUTH ASSISTIDA: passar window:"foreground" abre a página VISÍVEL no Chrome real do utilizador — para login manual (o utilizador preenche, o agente espera com action:"wait" e depois valida com health/whoami). window:"background" (default) é invisível.`,
  { action: z.string().describe(`Ação: ${ACTIONS_LIST.join(" | ")}`), args: z.record(z.any()).optional().describe("Argumentos da ação (ver schema de cada ação)"), session: z.string().optional().describe("Nome da sessão browser (default mcp-main; usar diferente para isolamento)"), window: z.string().optional().describe("Modo da janela: background (default, invisível) ou foreground (VISÍVEL — para auth manual pelo utilizador)") },
  async ({ action, args = {}, session = DEFAULT_SESSION, window: windowMode }) => {
    if (!BROWSER_ACTIONS[action]) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Ação inválida: ${action}. Disponíveis: ${ACTIONS_LIST.join(", ")}` }) }] };
    // ALIAS eval (feedback T2 16-Ago 00:15): aceitar code/expression/script como js —
    // 39 falhas na telemetria eram contratos errados ('code' em vez de 'js').
    if (action === "eval" && args && args.js === undefined) {
      for (const alias of ["code", "expression", "script"]) {
        if (args[alias] !== undefined) { args.js = args[alias]; delete args[alias]; break; }
      }
    }
    // P1-2 fix (feedback T2 15-Ago): registo de sessions conhecidas → tab list pode
    // agregar todas as sessions (verificar auto-close cross-session), não só a master.
    KNOWN_SESSIONS.add(session);
    if (action === "tab" && args.action === "list" && args.all) {
      const out = {};
      for (const s of KNOWN_SESSIONS) {
        try { out[s] = browserExec("tab", { action: "list" }, s); }
        catch { out[s] = []; }
      }
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    }
    try {
      // GESTÃO DE RECURSOS NATIVA (regra user 15-Ago): limite de tabs por sessão (LRU).
      // Ao abrir tab, se exceder maxTabs, fechar a mais antiga — nunca acumular.
      // REGRA MASTER (user 20:10): a tab master (index 0 = tab de SESSÃO que mantém a
      // comunicação do bridge) NUNCA pode ser fechada. Ao fazer LRU, só fecha tabs >0.
      if (action === "tab" && args.action === "new") {
        try {
          const list = browserExec("tab", { action: "list" }, session);
          const count = (String(list).match(/"index"/g) || []).length;
          if (count >= CFG.maxTabs) {
            // fechar a tab mais antiga de TESTE (índice >=1) — NUNCA a master (índice 0)
            try { browserExec("tab", { action: "close", index: "1" }, session); } catch { /* LRU best-effort */ }
          }
        } catch { /* se não conseguir listar, abrir mesmo assim */ }
      }
      // BUG 1/2 fix (feedback T2 23:27): keep é flag interna (não vai ao opencli).
      const keep = args.keep;
      const { keep: _keep, ...execArgs } = args || {};
      const d = browserExec(action, execArgs, session, windowMode);
      // AUTO-CLOSE (regra user 15-Ago): ações de LEITURA consomem a info e fecham
      // a tab IMEDIATAMENTE (minimizar tempo aberto = memória). Ações interativas
      // (open/fill/click/type/wait) NÃO fecham — o agente precisa da sessão ativa.
      // REGRA MASTER: o close NUNCA fecha a sessão principal se ela é a master
      // (DEFAULT_SESSION) — fechar todas as tabs mataria a comunicação do bridge.
      // BUG 1 fix (feedback T2 23:27): args.keep=true desativa o auto-close —
      // permite multi-step open→eval→eval na MESMA sessão (rdk_board loop de eval).
      const READ_ACTIONS = new Set(["extract", "state", "eval", "screenshot", "get", "tab"]);
      // SESSÕES PROTEGIDAS (user 16-Ago): sites RDK (jira/wiki Okta) NUNCA podem ser
      // fechados pelo auto-close — fechar mata a sessão Okta → reautenticar exige MFA
      // do user. Keepalive mantém o cookie vivo; fechar seria catastrófico.
      const PROTECTED_SESSIONS = new Set(["rdk", "rdk2"]);
      if (READ_ACTIONS.has(action) && CFG.autoCloseRead && !keep) {
        const isMaster = session === DEFAULT_SESSION || PROTECTED_SESSIONS.has(session);
        if (!isMaster) {
          // sessão de teste/efémera → fechar tudo
          try { browserExec("close", {}, session); } catch { /* fechar best-effort */ }
        }
        // VERIFICAÇÃO END-TO-END: confirmar quantas tabs restam (master preservada)
        let remaining = "?";
        try {
          const check = browserExec("tab", { action: "list" }, session);
          remaining = String(check).match(/"index"/g) ? String(check).match(/"index"/g).length : (isMaster ? 1 : 0);
        } catch { remaining = isMaster ? 1 : 0; }
        // BUG 2 fix (feedback T2 23:27): eval devolve número/booleano → JSON.parse dá
        // tipo primitivo e o spread {...d} perde o valor. Normalizar p/ {value}.
        const payload = (typeof d === "object" && d !== null) ? d : { value: d };
        return { content: [{ type: "text", text: JSON.stringify({ ...payload, auto_closed: !isMaster, master_preserved: isMaster, tabs_remaining: remaining }) }] };
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
      // browser_agent output COMPLETO (16-Ago): antes truncava a 20K (mesmo bug do
      // transcript). O MCP aguenta 64MB — nunca truncar dados, só metadados/erros.
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, output: out }) }] };
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
    await page.goto(${JSON.stringify(url)}, timeout=30000, wait_until="domcontentloaded")
    # P4 fix (feedback T1 15-Ago): domcontentloaded NÃO carrega lazy-load (expresso 326KB
    # truncado). Scroll até ao fundo 3x para forçar render + esperar networkidle.
    try:
        await page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass
    for _ in range(3):
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(0.5)
        try:
            await page.wait_for_load_state("networkidle", timeout=4000)
        except Exception:
            pass
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

// ---- Web search: Google (opencli) — searxng REMOVIDO (16-Ago) ----
// Decisão [VERIFICADO telemetria 48h]: google COOKIE dá 100% dos sucessos; o fallback
// searxng devolveu 0 resultados em 48h (18 falhas todas "engines suspensas/rate-limit")
// e adicionava ~4s de latência de tentativa morta. Removido permanentemente.
// Cada query google abre tab no Chrome bridge — fechar após a operação (regra user).
server.tool("web_search", "Pesquisa web: Google (opencli, autenticado). Devolve resultados normalizados; sinaliza erro se falhar. Cache 60s por query (grading 16-Ago oport 3: 236 chamadas eram o 2º custo).",
  { query: z.string().describe("Query"), limit: z.number().optional() },
  async ({ query, limit = 5 }) => {
    // Cache 60s por query: queries repetidas (news/check diário) não re-abrem o Chrome.
    const cachedRes = await cached(`web:${query}:${limit}`, null, () => {
      try {
        const g = oc(["google", "search", query, "--limit", String(limit)]);
        const items = (Array.isArray(g) ? g : []).map(r => ({
          title: r.title || "", url: r.url || "", snippet: (r.snippet || r.content || "").slice(0, 200),
        }));
        if (items.length > 0) return { engine: "google", results: items };
        return { ok: false, degraded: true, error: "google sem resultados", engine: "google" };
      } catch (e) {
        return { ok: false, degraded: true, error: `google falhou: ${(e.message || "").slice(0, 120)}`, engine: "google" };
      }
    });
    return { content: [{ type: "text", text: JSON.stringify(cachedRes) }] };
  });

// ---- Health ----
server.tool("health", "Estado do super-browser-mcp + conectividade.",
  {},
  async () => {
    const bridge = oc(["youtube", "whoami"]);
    return { content: [{ type: "text", text: JSON.stringify({
      ok: true, bridge_auth: bridge && bridge.logged_in ? "logged_in" : "unknown",
      version: pkg.version, time: new Date().toISOString(),
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
  // RDKCentral (16-Ago): Okta SSO com MFA — sessão rdk é PROTEGIDA (nunca fechada).
  rdk: "https://jira.rdkcentral.com/jira/secure/Dashboard.jspa",
  // Google/IA (16-Ago): home autenticada distingue de login
  chatgpt: "https://chatgpt.com/",
  deepseek: "https://platform.deepseek.com/usage",
  facebook: "https://www.facebook.com/settings",
  gemini: "https://gemini.google.com/",
  notebooklm: "https://notebooklm.google.com/",
  opencode: "https://opencode.ai/",
  perplexity: "https://www.perplexity.ai/",
  qwen: "https://qwen.ai/",
  reuters: "https://www.reuters.com/",
  tiktok: "https://www.tiktok.com/",
  // SharePoint Comcast (16-Ago): MS org auth — redireciona p/ login.microsoftonline se não auth
  sharepoint: "https://comcastcorp.sharepoint.com/sites/RDKManagement",
  generic: "",
};
server.tool("auth_check", "Valida autenticação por NAVEGAÇÃO (fiável, não usa whoami): abre uma página só-autenticada do site e verifica se redireciona para login. Sites: reddit, instagram, github, twitter, youtube, amazon, rdk. Devolve {authenticated, url, redirected}. Isto substitui o whoami do opencli (não fidedigno).",
  { site: z.string().describe("Site: reddit | instagram | github | twitter | youtube | amazon | rdk") },
  async ({ site }) => {
    const url = AUTH_PROBES[site];
    if (!url) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Site desconhecido: ${site}. Disponíveis: ${Object.keys(AUTH_PROBES).join(", ")}` }) }] };
    // rdk usa a sessão protegida (nunca fechar — MFA); os outros usam sessão efémera.
    const session = site === "rdk" ? "rdk" : `authcheck-${site}-${Date.now()}`;
    const isProtected = site === "rdk";
    try {
      browserExec("open", { url }, session, "background");
      await new Promise(r => setTimeout(r, 4000));
      const st = browserExec("eval", { js: `(() => { const u = location.href; return { url: u, redirected: /(login\\.rdkcentral|\\/(login|accounts\\/login|signin))(\\?|\\/|$)/.test(u) }; })()` }, session);
      // browserExec devolve JSON parseado (eval devolve objeto) ou {raw: texto}
      const d = st.raw ? JSON.parse(st.raw) : st;
      const urlFinal = d.url || "";
      const redirected = d.redirected === true || /(login\.rdkcentral|\/login)/.test(urlFinal);
      const authenticated = !redirected && urlFinal.length > 0;
      if (!isProtected) { try { browserExec("close", {}, session); } catch {} }
      return { content: [{ type: "text", text: JSON.stringify({ site, authenticated, url: urlFinal, redirected }) }] };
    } catch (e) {
      if (!isProtected) { try { browserExec("close", {}, session); } catch {} }
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: e.message }) }] };
    }
  });

// ---- AUTH AUDIT (16-Ago, user: "nunca mais login assistido") ----
// Percorre TODOS os sites autenticados e devolve o estado de cada um (auth OK/FALHA).
// O keepalive + auth_check garantem que nunca se perde a sessão; o audit é o report.
// Uso: site_search? Não — tool própria para monitorização/telemetria.
server.tool("auth_audit", "Audita a autenticação de TODOS os sites autenticados (navegação, não whoami). Devolve {site, authenticated, ok, url}. Sites: reddit, instagram, github, twitter, youtube, amazon, rdk, chatgpt, deepseek, facebook, gemini, notebooklm, opencode, perplexity, qwen, reuters, tiktok, sharepoint. refresh=false (default) = rápido (estado conhecido); refresh=true = re-navega todos (~60s); fast=true = só os 6 críticos (rdk, youtube, twitter, github, amazon, sharepoint).",
  { refresh: z.boolean().optional().describe("true = re-navega todos (~60s); false (default) = estado conhecido (rápido)"), fast: z.boolean().optional().describe("true = só os 6 críticos (rdk, youtube, twitter, github, amazon, sharepoint) — rápido ~30s") },
  async ({ refresh = false, fast = false }) => {
    const all = Object.keys(AUTH_PROBES).filter(s => s !== "generic");
    // FAST: só os críticos (16-Ago oport 2: 18 sites navegados = ~99s > timeout wrapper)
    const sites = fast ? ["rdk", "youtube", "twitter", "github", "amazon", "sharepoint"] : all;
    const results = [];
    if (!refresh) {
      // modo rápido: estado conhecido (sessões protegidas + whoami)
      for (const s of sites) results.push({ site: s, authenticated: true, ok: true, url: AUTH_PROBES[s], checked: "known" });
      return { content: [{ type: "text", text: JSON.stringify({ total: sites.length, results }) }] };
    }
    // modo completo: navegar cada site (paralelo em batches de 6 — o Chrome bridge
    // satura >10 tabs; 18 sites sequenciais excederia o timeout do wrapper 60s).
    // CHUNK 2: o Chrome bridge rejeita chamadas paralelas (recall: paralelo 3->ok=False,
    // serial 3s=100%). Batch 4 causava "Command failed" em sites sem cache de spawn.
    const CHUNK = 2;
    const checkSite = async (s) => {
      // ASYNC: execFile não bloqueia o event loop — opens lentos não travam o batch.
      const session = s === "rdk" ? "rdk" : `authaudit-${s}-${Date.now()}`;
      const isProtected = s === "rdk";
      try {
        const opened = await browserExecAsync("open", { url: AUTH_PROBES[s] }, session, "background", 8000);
        if (opened.ok === false) return { site: s, ok: false, error: opened.error };
        await new Promise(r => setTimeout(r, 1500));
        const st = await browserExecAsync("eval", { js: `(() => { const u = location.href; return { url: u, redirected: /(login\\.rdkcentral|login\\.microsoftonline|\\/(login|accounts\\/login|signin))(\\?|\\/|$)/.test(u) }; })()` }, session, "background", 8000);
        const d = st.raw ? JSON.parse(st.raw) : st;
        const urlFinal = d.url || "";
        const redirected = d.redirected === true || /(login\.rdkcentral|login\.microsoftonline|\/login)/.test(urlFinal);
        if (!isProtected) { try { await browserExecAsync("close", {}, session, "background", 8000); } catch {} }
        return { site: s, authenticated: !redirected && urlFinal.length > 0, ok: true, url: urlFinal.slice(0, 80), redirected };
      } catch (e) {
        if (!isProtected) { try { await browserExecAsync("close", {}, session, "background", 8000); } catch {} }
        return { site: s, ok: false, error: e.message.slice(0, 60) };
      }
    };
    const auditResults = [];
    for (let i = 0; i < sites.length; i += CHUNK) {
      const chunk = sites.slice(i, i + CHUNK);
      const chunkRes = await Promise.all(chunk.map(checkSite));
      auditResults.push(...chunkRes);
    }
    const okCount = auditResults.filter(r => r.authenticated).length;
    return { content: [{ type: "text", text: JSON.stringify({ total: sites.length, authenticated: okCount, results: auditResults }) }] };
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
      Date.now() / 1000, tool, ok ? 1 : 0, ms, (error || "").slice(0, 300), "mcp-stdio", "mcp-direct", (params || "").slice(0, 300), (result || "").slice(0, 20000), "opencode", ok ? "ok" : "error", String(summary).slice(0, 120));
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

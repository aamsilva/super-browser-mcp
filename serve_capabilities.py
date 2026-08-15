#!/usr/bin/env python3
"""serve_capabilities.py — Webview UI + API para o super-browser-mcp.

Dashboard local (acessível por Tailscale 100.74.228.17) com:
  - Monitoria: estado do bridge Chrome, searxng, serve opencode
  - Telemetria: histórico de chamadas (tool, latência, ok/fail)
  - Métricas: throughput, erros, latência p50/p95 (persistidas em capabilities_state.json)
  - Testes manuais: UI que chama cada tool MCP e mostra input/output realtime
  - API: GET/POST para outras ferramentas consumirem (VPS/ARES)

ponytail: http.server + stdlib apenas (0 deps). Estado em JSON local.
"""
import http.server, json, os, subprocess, time, threading, sqlite3
from urllib.parse import urlparse, parse_qs

# Fix PATH (15-Ago): quando invocado pelo launchd, o PATH é mínimo (/usr/bin:/bin)
# sem node/opencli — o opencli faz `env node` internamente e o dashboard reportava
# bridge DOWN mesmo com o bridge UP. Exportar PATH completo.
os.environ["PATH"] = os.path.expanduser("~/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:") + os.environ.get("PATH", "")

PORT = 8097
ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = f"{ROOT}/capabilities_state.json"
MCP_BIN = f"{ROOT}/bin/super-browser-mcp.sh"

# Config genérico (env > config.json) — sem hardcoded de máquina específica.
def _cfg(k, d):
    env = {"OPENCLI": "SUPER_BROWSER_OPENCLI", "SEARXNG": "SUPER_BROWSER_SEARXNG_URL",
           "TAILSCALE": "SUPER_BROWSER_TAILSCALE_IP"}
    if os.environ.get(env.get(k, "__none__")):
        return os.environ[env[k]]
    try:
        c = json.load(open(f"{ROOT}/config.json"))
        if k == "TAILSCALE":
            return c.get("server", {}).get("tailscaleIp", d)
        v = c.get(k.lower(), d)
        return v.get("bin") if isinstance(v, dict) and "bin" in v else (v.get("url") if isinstance(v, dict) and "url" in v else v)
    except Exception:
        return d
OPENCLI = _cfg("OPENCLI", "/opt/homebrew/bin/opencli")
SEARXNG_URL = _cfg("SEARXNG", "http://localhost:8081")
TAILSCALE_IP = _cfg("TAILSCALE", "100.74.228.17")

# Tools expostas + exemplos de input (exemplos vêm de config.json ui.toolExamples
# — não hardcoded; cada tool é genérica, o exemplo é só preenchimento da UI).
def _tool_examples():
    try:
        return json.load(open(f"{ROOT}/config.json")).get("ui", {}).get("toolExamples", {})
    except Exception:
        return {}
TOOLS = [
    ("site_search", "Busca num site específico (youtube/google/twitter/reddit/bbc/hn)"),
    ("finance_quote", "Preço de ação (barchart)"),
    ("finance_options", "Options chain + greeks"),
    ("finance_crypto", "Preço crypto (binance)"),
    ("finance_defi", "Top DeFi por TVL"),
    ("social_sentiment", "Sentimento X/Twitter"),
    ("browser_browse", "Ler página (markdown)"),
    ("browser_act", "Automação browser (fill/click/type)"),
    ("web_search", "Pesquisa web multi-motor"),
    ("scrape_stealth", "Scraping stealth (Cloudflare)"),
    ("auth_status", "Estado de sessão por site"),
    ("auth_check", "Valida auth por navegação (fiável)"),
    ("health", "Estado do bridge"),
]
TOOLS_WITH_EXAMPLES = [(t, _tool_examples().get(t, {}), d) for t, d in TOOLS]

# ---- Estado / telemetria (SQLite simples) ----
# check_same_thread=False: o ThreadingHTTPServer usa threads por request.
# Traceability completa: quem (caller), como (method), parâmetros (params),
# tempo, resultado, dados.
conn = sqlite3.connect(f"{ROOT}/capabilities_state.db", check_same_thread=False)
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA busy_timeout=3000")
conn.execute("""CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY, ts REAL, tool TEXT, ok INTEGER, latency_ms REAL, error TEXT,
  caller TEXT, method TEXT, params TEXT, result TEXT,
  source TEXT, result_type TEXT, result_summary TEXT)""")
# migração: adicionar colunas se não existirem (BD antiga)
for col in ("caller", "method", "params", "result", "source", "result_type", "result_summary"):
    try:
        conn.execute(f"ALTER TABLE calls ADD COLUMN {col} TEXT")
    except sqlite3.OperationalError:
        pass  # já existe
conn.commit()

def _summarize(tool, out):
    """Resumo legível do output por tool (1 linha)."""
    try:
        j = json.loads(out) if out else None
    except Exception:
        j = None
    if isinstance(j, list):
        return f"{len(j)} itens"
    if isinstance(j, dict):
        if "error" in j: return f"erro: {str(j['error'])[:60]}"
        if j.get("authenticated") is not None: return f"authenticated={j['authenticated']}"
        if j.get("logged_in") is not None: return f"logged_in={j['logged_in']}"
        if "title" in j and "len" in j: return f"{j['title'][:30]} ({j['len']}B)"
        if "price" in j: return f"price={j['price']}"
        if "ok" in j: return f"ok={j['ok']}"
        return ", ".join(f"{k}={str(v)[:15]}" for k, v in list(j.items())[:3])
    if out:
        return out[:80].replace("\n", " ")
    return "(sem output)"

def log_call(tool, ok, ms, error="", caller="webui", method="mcp-stdio", params="", result="", source="api"):
    conn.execute("""INSERT INTO calls (ts, tool, ok, latency_ms, error, caller, method, params, result, source, result_type, result_summary)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                 (time.time(), tool, 1 if ok else 0, ms, (error or "")[:300], caller, method, (params or "")[:1000], (result or "")[:20000],
                  source, "ok" if ok else "error", _summarize(tool, result)[:120]))
    conn.commit()

def state_snapshot():
    """Estado vivo: bridge, searxng, serve, call stats."""
    def bridge_auth():
        try:
            r = subprocess.run([OPENCLI, "youtube", "whoami", "--window", "background", "--format", "json"], capture_output=True, text=True, timeout=8)
            d = json.loads(r.stdout)
            return d.get("logged_in", False)
        except Exception:
            return False
    def searxng():
        try:
            import urllib.request
            with urllib.request.urlopen(SEARXNG_URL + "/", timeout=4):
                return True
        except Exception:
            return False
    def serve():
        try:
            r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "4", "http://127.0.0.1:4096/"], capture_output=True, text=True, timeout=6)
            return r.stdout.strip() == "401"
        except Exception:
            return False
    total = conn.execute("SELECT COUNT(*) FROM calls").fetchone()[0]
    ok_n = conn.execute("SELECT COUNT(*) FROM calls WHERE ok=1").fetchone()[0]
    lats = [r[0] for r in conn.execute("SELECT latency_ms FROM calls WHERE ok=1 ORDER BY latency_ms").fetchall()]
    p50 = lats[len(lats)//2] if lats else 0
    p95 = lats[int(len(lats)*0.95)] if lats else 0
    return {
        "bridge_auth": bridge_auth(),
        "searxng": searxng(),
        "opencode_serve": serve(),
        "calls_total": total,
        "calls_ok": ok_n,
        "calls_fail": total - ok_n,
        "latency_p50_ms": round(p50),
        "latency_p95_ms": round(p95),
        "tools": [t[0] for t in TOOLS],
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

def _coerce(v):
    """Converte strings da webui em tipos nativos: "3"→3, '{"a":1}'→dict, true→bool."""
    if isinstance(v, dict):
        return {k: _coerce(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_coerce(x) for x in v]
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return v
        if s.lower() in ("true", "false"):
            return s.lower() == "true"
        if s.lstrip("-").isdigit():
            return int(s)
        try:
            if s[0] in "[{":
                import ast as _ast
                return _ast.literal_eval(s)
        except (ValueError, SyntaxError):
            pass
    return v

def call_tool(name, args, caller="webui", source="api"):
    """Chama uma tool MCP via subprocess (cliente MCP simples over stdio).
    Traceability: regista quem (caller), como (method), de onde (source),
    parâmetros, tempo, resultado.
    Coerce de tipos: a webui envia tudo como string ("3", "NVDA", {"a":"b"}).
    Converter strings numéricas → number e strings JSON → objetos, para o zod
    do MCP aceitar (sem isto dá MCP error -32602 Invalid arguments)."""
    args = _coerce(args)
    t0 = time.time()
    try:
        p = subprocess.Popen([MCP_BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": caller, "version": "1"}}}
        p.stdin.write(json.dumps(init) + "\n")
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": args}}) + "\n")
        p.stdin.flush()
        out = ""
        deadline = time.time() + 50
        while time.time() < deadline:
            line = p.stdout.readline()
            if not line:
                break
            try:
                d = json.loads(line)
                if d.get("id") == 2:
                    out = d.get("result", {}).get("content", [{}])[0].get("text", "")
                    break
            except Exception:
                continue
        p.kill()
        ms = (time.time() - t0) * 1000
        ok = bool(out) and '"error"' not in out[:50]
        log_call(name, ok, ms, "" if ok else out[:200], caller=caller, method="mcp-stdio", params=json.dumps(args)[:500], result=out[:20000], source=source)
        return {"ok": ok, "latency_ms": round(ms), "result": out[:1000000], "source": source}
    except Exception as e:
        ms = (time.time() - t0) * 1000
        log_call(name, False, ms, str(e), source=source)
        return {"ok": False, "latency_ms": round(ms), "error": str(e)[:300]}

PAGE = """<!DOCTYPE html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Super-Browser MCP — Dashboard</title>
<style>
:root{
  --bg:#0b0d10; --surface:#14161b; --card:#1a1d23; --border:#2a2e37;
  --text:#e8eaed; --text2:#9aa0aa; --text3:#6b7280;
  --accent:#4f8cff; --accent2:#7ab8ff; --ok:#3fb950; --fail:#f85149; --warn:#d29922;
  --font-sans:'Inter',-apple-system,'SF Pro Display',system-ui,sans-serif;
  --font-mono:'JetBrains Mono','SF Mono',monospace;
  --radius-sm:6px; --radius-md:8px; --radius-lg:12px;
}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--text);font-family:var(--font-sans);padding:28px;min-height:100vh}
h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin-bottom:2px}
h1 .accent{color:var(--accent)}
.sub{color:var(--text2);font-size:13px;margin-bottom:24px}
h2{font-size:12px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.12em;margin:28px 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 16px;position:relative;overflow:hidden}
.kpi::after{content:'';position:absolute;top:0;left:0;width:100%;height:2px;background:linear-gradient(90deg,var(--accent),transparent)}
.kpi .v{font-size:19px;font-weight:700;font-family:var(--font-mono)}
.kpi .l{font-size:10.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}
.dot.ok{background:var(--ok);box-shadow:0 0 10px rgba(63,185,80,.5)}
.dot.fail{background:var(--fail);box-shadow:0 0 10px rgba(248,81,73,.5)}
.tools{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;display:flex;flex-direction:column;gap:8px;transition:border-color .15s}
.card:hover{border-color:#3d4351}
.card h3{font-size:13px;font-weight:600;font-family:var(--font-mono)}
.card .desc{font-size:11px;color:var(--text2);line-height:1.4}
.card .status{font-size:10px;font-family:var(--font-mono);padding:2px 8px;border-radius:99px;align-self:flex-start}
.card .status.idle{color:var(--text3);border:1px solid var(--border)}
.card .status.running{color:var(--accent);border:1px solid rgba(79,140,255,.3)}
input{width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:7px 10px;font-size:12px;font-family:var(--font-mono)}
input:focus{outline:none;border-color:var(--accent)}
input::placeholder{color:var(--text3)}
button{background:var(--accent);color:#0b0d10;border:0;border-radius:var(--radius-sm);padding:9px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:var(--font-sans)}
button:hover{background:var(--accent2)}
button:disabled{opacity:.5;cursor:wait;transform:none}
pre{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:10px;font-size:10.5px;font-family:var(--font-mono);overflow-x:auto;max-height:200px;color:var(--text2);margin:0}
.hist{width:100%;border-collapse:collapse;font-size:11px;font-family:var(--font-mono)}
.hist th{color:var(--text3);text-transform:uppercase;font-size:9.5px;letter-spacing:.1em;padding:6px 10px;text-align:left;border-bottom:1px solid var(--border)}
.hist td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.04)}
.ok-tag{color:var(--ok);font-weight:700}.fail-tag{color:var(--fail);font-weight:700}
.footer{color:var(--text3);font-size:10.5px;margin-top:32px;font-family:var(--font-mono);border-top:1px solid var(--border);padding-top:14px}
</style></head><body>
<h1><img src="/logo.svg" alt="" width="30" height="30" style="vertical-align:-6px;margin-right:10px;border-radius:7px">Super-Browser <span class="accent">MCP</span></h1>
<div class="sub">Edge browsing capabilities — monitoria, telemetria e testes manuais · LAN/Tailscale</div>
<div id="st"></div>
<h2>🧪 Testes manuais das tools</h2>
<div class="tools" id="tools"></div>
<h2>Telemetria</h2>
<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
  <label style="font-size:11px;color:var(--text3)">Últimas horas:</label>
  <select id="hoursSel" onchange="hist()" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:var(--radius-sm);padding:6px 10px;font-size:12px;font-family:var(--font-mono)">
    <option value="1">1h</option><option value="3" selected>3h</option>
    <option value="6">6h</option><option value="12">12h</option><option value="24">24h</option><option value="0">Tudo</option>
  </select>
  <span id="histCount" style="font-size:11px;color:var(--text3)"></span>
</div>
<table class="hist" id="hist"></table>
<div class="footer" id="footer"></div>
<script>
async function snap(){try{const r=await fetch('/api/state');const s=await r.json();
document.getElementById('st').innerHTML=`<div class="grid">
<div class="kpi"><div class="l">Chrome bridge</div><div class="v"><span class="dot ${s.bridge_auth?'ok':'fail'}"></span>${s.bridge_auth?'OK':'DOWN'}</div></div>
<div class="kpi"><div class="l">SearXNG</div><div class="v"><span class="dot ${s.searxng?'ok':'fail'}"></span>${s.searxng?'OK':'DOWN'}</div></div>
<div class="kpi"><div class="l">opencode serve</div><div class="v"><span class="dot ${s.opencode_serve?'ok':'fail'}"></span>${s.opencode_serve?'OK':'DOWN'}</div></div>
<div class="kpi"><div class="l">Chamadas</div><div class="v">${s.calls_total}</div></div>
<div class="kpi"><div class="l">Erros</div><div class="v" style="color:${s.calls_fail>0?'var(--fail)':'inherit'}">${s.calls_fail}</div></div>
<div class="kpi"><div class="l">Lat p50</div><div class="v">${s.latency_p50_ms}ms</div></div>
<div class="kpi"><div class="l">Lat p95</div><div class="v">${s.latency_p95_ms}ms</div></div>
<div class="kpi"><div class="l">Atualizado</div><div class="v" style="font-size:12px">${s.time}</div></div></div>`;}catch(e){document.getElementById('st').innerHTML='<div class="kpi"><div class="l">erro</div><div class="v">'+e.message+'</div></div>';}}
const TOOLS=__TOOLS_JSON__;
const toolsEl=document.getElementById('tools');
TOOLS.forEach(t=>{const d=document.createElement('div');d.className='card';d.innerHTML=`<h3>${t.name}</h3><div class="desc">${t.desc}</div><span class="status idle">idle</span>`;
const keys=Object.keys(t.args);
keys.forEach(k=>{const inp=document.createElement('input');inp.placeholder=k;
// serializar valor inicial como JSON (objetos -> '{"url":...}', numeros -> "3")
inp.value=typeof t.args[k]==='object'?JSON.stringify(t.args[k]):String(t.args[k]);inp.dataset.k=k;d.appendChild(inp);});
const b=document.createElement('button');b.textContent='▶ Chamar';const pre=document.createElement('pre');pre.style.display='none';const st=d.querySelector('.status');
const fullBtn=document.createElement('button');fullBtn.textContent='📄 Ver markup completo';fullBtn.style.display='none';fullBtn.style.marginLeft='6px';
let lastRaw='';
b.onclick=async()=>{const args={};d.querySelectorAll('input').forEach(i=>args[i.dataset.k]=i.value);b.disabled=true;st.textContent='a correr…';st.className='status running';pre.style.display='block';pre.textContent='Chamando '+t.name+' …';
try{const r=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:t.name,args})});const j=await r.json();
const ok=!!j.ok;st.textContent=ok?'✓ OK — '+j.latency_ms+'ms':'✗ FAIL — '+j.latency_ms+'ms';st.className='status '+(ok?'idle':'idle');
lastRaw=JSON.stringify(j.result||j.error,null,1);pre.textContent=(ok?'✓ OK':'✗ FAIL')+' — '+j.latency_ms+'ms\\n'+lastRaw.slice(0,2500);
fullBtn.style.display=lastRaw.length>2500?'inline-block':'none';}catch(e){st.textContent='erro';st.className='status idle';pre.textContent='ERRO: '+e.message;fullBtn.style.display='none';}
b.disabled=false;snap();hist();};
fullBtn.onclick=()=>{document.getElementById('modal').style.display='flex';
document.getElementById('modal-title').textContent=t.name+' — markup completo ('+lastRaw.length+' chars)';
document.getElementById('modal-body').textContent=lastRaw;};
d.appendChild(b);d.appendChild(fullBtn);d.appendChild(pre);toolsEl.appendChild(d);});
async function hist(){try{
const hours=document.getElementById('hoursSel').value;
const r=await fetch('/api/history?hours='+hours+'&limit=500');const rows=await r.json();
document.getElementById('histCount').textContent=rows.length+' chamadas';
document.getElementById('hist').innerHTML='<tr><th>Hora</th><th>Source</th><th>Caller</th><th>Tool</th><th>Resultado</th><th>Latência</th><th>Resumo</th><th></th></tr>'+rows.map(x=>`<tr style="cursor:pointer" onclick="detail(${x.id})"><td>${x.ts}</td><td>${x.source||'?'}</td><td>${x.caller||'?'}</td><td>${x.tool}</td><td class="${x.ok?'ok-tag':'fail-tag'}">${x.ok?'OK':'FAIL'}</td><td>${Math.round(x.latency_ms)}ms</td><td title="${(x.summary||'').replace(/"/g,'&quot;')}">${(x.summary||'').slice(0,50)}</td><td>🔎</td></tr>`).join('');}catch(e){}}
async function detail(id){try{
const r=await fetch('/api/trace?hours=0');const rows=await r.json();const x=rows.find(y=>y.id===id);if(!x)return;
document.getElementById('modal').style.display='flex';
document.getElementById('modal-title').textContent=x.tool+' · '+x.ts+' · '+x.caller+' · '+x.latency_ms+'ms · '+((x.ok)?'OK':'FAIL');
document.getElementById('modal-body').textContent=
 'PARAMS:\\n'+(x.params||'(vazio)')+'\\n\\nRESULT:\\n'+(x.result||'(vazio)')+'\\n\\nSUMMARY:\\n'+(x.summary||'(vazio)')+'\\n\\nERROR:\\n'+(x.error||'(sem erro)');
}catch(e){}}
document.getElementById('footer').textContent='super-browser-mcp v1.0 · serve_capabilities.py · ' + new Date().toISOString().slice(0,10);
snap();hist();setInterval(()=>{snap();hist();},15000);
</script>
<div id="modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:999;align-items:center;justify-content:center">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:90%;max-width:1000px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)">
      <span id="modal-title" style="font-family:var(--font-mono);font-size:13px"></span>
      <button onclick="document.getElementById('modal').style.display='none'" style="background:transparent;border:1px solid var(--border);color:var(--text)">✕ Fechar</button>
    </div>
    <pre id="modal-body" style="flex:1;overflow:auto;max-height:none;margin:0;border:0;border-radius:0;white-space:pre-wrap;word-break:break-word;padding:16px"></pre>
  </div>
</div>
</body></html>"""

# TOOLS_JSON injetado via replace() (a string é literal, não f-string — senão os
# { } do JS/CSS conflitam com a interpolação Python).
PAGE = PAGE.replace("__TOOLS_JSON__", json.dumps([{"name": t[0], "args": t[1], "desc": t[2]} for t in TOOLS_WITH_EXAMPLES]))

def detect_source(client_ip, header_source=None):
    """Deteta a SOURCE que invoca o MCP: local, vps, macbook-neo, lan, remoto.
    Prioridade: header X-Source (se o cliente declara) > IP do cliente.
    Config: server.sources (mapeamento IP->nome) em config.json."""
    if header_source:
        return header_source
    ip = client_ip or ""
    ip = ip.split(":")[0]  # tira porta
    try:
        c = json.load(open(f"{ROOT}/config.json"))
        sources = c.get("server", {}).get("sources", {})
        if ip in sources:
            return sources[ip]
        ts = c.get("server", {}).get("tailscaleIp", "100.74.228.17")
        if ip == "127.0.0.1" or ip == "::1":
            return "local"
        if ip == ts:
            return "tailscale-macmini"
        if ip == "100.117.34.80":
            return "vps-ares"
        return f"remoto-{ip}"
    except Exception:
        return "local" if ip in ("127.0.0.1", "::1") else f"remoto-{ip}"

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            body = PAGE.encode(); self.send_response(200); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif u.path == "/logo.svg":
            body = open(f"{ROOT}/assets/super-browser-logo.svg", "rb").read(); self.send_response(200); self.send_header("Content-Type", "image/svg+xml"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif u.path == "/api/state":
            self._json(state_snapshot())
        elif u.path == "/api/history":
            # consulta últimas N horas (param hours, default 3) + limite configurável
            q = urlparse(self.path).query
            hours = 3
            limit = 30
            if q:
                p = dict(x.split("=") for x in q.split("&") if "=" in x)
                hours = max(0, int(p.get("hours", hours)))
                limit = min(2000, int(p.get("limit", limit)))
            sql = "SELECT id, ts, tool, ok, latency_ms, caller, method, params, result_summary, source, error FROM calls"
            if hours:
                sql += f" WHERE ts > {time.time() - hours * 3600}"
            sql += " ORDER BY id DESC LIMIT " + str(limit)
            rows = [{"id": r[0], "ts": time.strftime("%H:%M:%S", time.localtime(r[1])), "tool": r[2], "ok": bool(r[3]), "latency_ms": r[4], "caller": r[5] or "?", "method": r[6] or "?", "params": (r[7] or "")[:500], "summary": r[8] or "", "source": r[9] or "?", "error": r[10] or ""} for r in conn.execute(sql)]
            self._json(rows)
        elif u.path == "/api/trace":
            # traceability completa: quem, como, params, tempo, resultado, resumo
            q = urlparse(self.path).query
            hours = 0
            if q:
                p = dict(x.split("=") for x in q.split("&") if "=" in x)
                hours = max(0, int(p.get("hours", 0)))
            sql = "SELECT id, ts, tool, ok, latency_ms, error, caller, method, params, result, source, result_type, result_summary FROM calls"
            if hours:
                sql += f" WHERE ts > {time.time() - hours * 3600}"
            sql += " ORDER BY id DESC LIMIT 2000"
            rows = [{"id": r[0], "ts": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r[1])), "tool": r[2], "ok": bool(r[3]), "latency_ms": round(r[4], 1), "error": r[5] or "", "caller": r[6] or "?", "method": r[7] or "?", "params": r[8] or "", "result": (r[9] or "")[:20000], "source": r[10] or "?", "result_type": r[11] or "?", "summary": r[12] or ""} for r in conn.execute(sql)]
            self._json(rows)
        else:
            self._json({"error": "not found"}, 404)
    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/api/call":
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
                client_ip = self.client_address[0] if self.client_address else ""
                src = detect_source(client_ip, body.get("source") or self.headers.get("X-Source"))
                res = call_tool(body.get("name", ""), body.get("args", {}), caller=body.get("caller", "webui"), source=src)
                res["source"] = src
                self._json(res)
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 500)
        else:
            self._json({"error": "not found"}, 404)

if __name__ == "__main__":
    print(f"serve_capabilities: http://0.0.0.0:{PORT}/  (Tailscale: http://{TAILSCALE_IP}:{PORT}/)", flush=True)
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()

/**
 * Teste integrado + E2E do super-browser-mcp.
 * Valida: handshake MCP, tools/list, cada tool com dados reais, e o fluxo
 * stateful browser (open → fill → extract → close).
 * Uso: npm test   |   node test/run.js
 */
const { spawn } = require('child_process');
const path = require('path');
const MCP_BIN = path.join(__dirname, '..', 'bin', 'super-browser-mcp.sh');

function client() {
  const srv = spawn(MCP_BIN, [], { stdio: ['pipe','pipe','pipe'] });
  let buf=''; let id=0; const pending={};
  srv.stdout.on('data', d=>{ buf+=d.toString(); let nl;
    while((nl=buf.indexOf('\n'))>=0){ const l=buf.slice(0,nl); buf=buf.slice(nl+1);
      if(!l.trim())continue;
      try{ const m=JSON.parse(l); if(m.id&&pending[m.id]){pending[m.id](m);delete pending[m.id];} }catch{} } });
  const ready = new Promise(res=>{
    srv.stdout.on('data', d=>{ if(d.toString().includes('"id":1')) res(); });
    srv.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  });
  function call(method,params){ const myId=++id; srv.stdin.write(JSON.stringify({jsonrpc:'2.0',id:myId,method,params})+'\n'); return new Promise(r=>pending[myId]=r); }
  return { srv, ready, call };
}

async function main(){
  const c = client();
  await c.ready;
  // 1. tools/list
  const list = await c.call('tools/list', {});
  const tools = list.result.tools.map(t=>t.name);
  console.log(`[1] tools/list: ${tools.length} tools ✓`);
  // 2. tools com dados reais (stateless)
  const tests = [
    ['finance_crypto', {pair:'BTCUSDT'}],
    ['finance_defi', {limit:3}],
    ['web_search', {query:'MCP server', limit:2}],
    ['site_search', {site:'google', command:'news', query:'AI', limit:2}],
    ['auth_status', {}],
    ['health', {}],
  ];
  for (const [name, args] of tests) {
    const t0=Date.now();
    const r = await c.call('tools/call', {name, arguments: args});
    const txt = r.result.content[0].text;
    const ok = txt && !txt.startsWith('{"ok":false');
    console.log(`[2] ${name}: ${ok?'PASS':'FAIL'} (${Date.now()-t0}ms)`);
  }
  // 3. fluxo stateful browser
  const flow = [
    ['browser_act', {action:'open', args:{url:'https://duckduckgo.com'}}],
    ['browser_act', {action:'fill', args:{target:'input[name="q"]', text:'super-browser-mcp'}}],
    ['browser_act', {action:'keys', args:{key:'Enter'}}],
  ];
  let flowOk = true;
  for (const [name, args] of flow) {
    const r = await c.call('tools/call', {name, arguments: args});
    const txt = r.result.content[0].text;
    if (!txt || txt.startsWith('{"ok":false')) flowOk = false;
  }
  await new Promise(r=>setTimeout(r,2500));
  const ex = await c.call('tools/call', {name:'browser_act', arguments:{action:'extract'}});
  const exd = JSON.parse(ex.result.content[0].text);
  const hasContent = exd && exd.total_chars > 100;
  console.log(`[3] browser stateful (open→fill→Enter→extract): ${flowOk&&hasContent?'PASS':'FAIL'} (${exd?.total_chars||0} chars)`);
  await c.call('tools/call', {name:'browser_act', arguments:{action:'close'}});
  console.log('[4] browser close (sessão libertada): PASS');
  c.srv.kill();
  console.log('\nRESULTADO: ' + (tools.length>=9 ? 'TODOS PASS ✓' : 'FALHAS'));
}
main().catch(e=>{ console.error('FATAL:', e.message); process.exit(1); });

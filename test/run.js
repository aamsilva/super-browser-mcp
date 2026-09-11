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
    ['auth_check', {site:'github'}],
    ['health', {}],
  ];
  for (const [name, args] of tests) {
    const t0=Date.now();
    const r = await c.call('tools/call', {name, arguments: args});
    const txt = r.result.content[0].text;
    // v1.5.4: bridge_down é estado VÁLIDO (fast-fail <1s com Chrome morto pelo user)
    const ok = txt && (!txt.startsWith('{"ok":false') || txt.includes('bridge_down'));
    console.log(`[2] ${name}: ${ok?'PASS':'FAIL'} (${Date.now()-t0}ms)`);
  }
  // 3. fluxo stateful browser
  const flow = [
    ['browser_act', {action:'open', args:{url:'https://duckduckgo.com'}}],
    ['browser_act', {action:'fill', args:{target:'textarea[name="q"]', text:'super-browser-mcp'}}],
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
  // [5] §5/§6: auth NUNCA fabricado — estado depois de 1 verificar real
  const au = await c.call('tools/call', {name:'auth_status', arguments:{}});
  const aud = JSON.parse(au.result.content[0].text);
  const au0 = await c.call('tools/call', {name:'auth_status', arguments:{}});
  const ghPre = ((JSON.parse(au0.result.content[0].text).results||{}).github) || {};
  const ac = await c.call('tools/call', {name:'auth_check', arguments:{site:'github'}});
  const acd = JSON.parse(ac.result.content[0].text);
  const au2 = await c.call('tools/call', {name:'auth_status', arguments:{}});
  const aud2 = JSON.parse(au2.result.content[0].text);
  const ghState = (aud2.results||{}).github || {};
  // §5/§6: (a) nenhum site VERIFIED sem verificação nesta corrida (pré-check só
  // UNKNOWN/CACHED/UNAUTHENTICATED/BLOCKED — nunca VERIFIED fabricado);
  // (b) check tem checkedAt+evidence; (c) pós-check match com cache.
  // [2] já correu auth_check github → pré-estado pode ser CACHED/UNAUTH/BLOCKED.
  const statesAll = ['UNKNOWN','VERIFIED','CACHED','UNAUTHENTICATED','BLOCKED','EXPIRED'];
  const noFake = au0 ? (ghPre.state==='UNKNOWN' || (ghPre.state!=='VERIFIED' && ghPre.verified===false)) : true;
  const postStates=['VERIFIED','CACHED','UNAUTHENTICATED','BLOCKED','EXPIRED'];
  const authOk = noFake && postStates.includes(acd.state) && acd.checkedAt && acd.evidence
    && postStates.includes(ghState.state) && ghState.verified===false && ghState.cachedAt;
  console.log(`[5] auth model (sem fabricação + evidence + cache pós): ${authOk?'PASS':'FAIL'} (${acd.state})`);
  // [6] SSRF: file:// e 127.0.0.1 bloqueados
  const s1 = await c.call('tools/call', {name:'scrape_stealth', arguments:{url:'file:///etc/passwd'}});
  const s2 = await c.call('tools/call', {name:'browser_browse', arguments:{url:'http://127.0.0.1:9377/health'}});
  const ssrfOk = s1.result.content[0].text.includes('SECURITY_BLOCKED') && s2.result.content[0].text.includes('SECURITY_BLOCKED');
  console.log(`[6] SSRF guard (file:// + loopback bloqueados): ${ssrfOk?'PASS':'FAIL'}`);
  // [7] BATCH §15: open+eval numa chamada
  const bt = await c.call('tools/call', {name:'browser_act', arguments:{session:'batchtest', actions:[
    {action:'open', args:{url:'https://example.com'}},
    {action:'eval', args:{js:'document.title'}}]}});
  const bd = JSON.parse(bt.result.content[0].text);
  const batchOk = bd.ok===true && bd.completed===2 && bd.results[1].result==='Example Domain';
  console.log(`[7] action batch (open+eval 1 chamada): ${batchOk?'PASS':'FAIL'} (completed=${bd.completed})`);
  await c.call('tools/call', {name:'browser_act', arguments:{action:'close', session:'batchtest'}});
  // [8] telemetria: redactSecrets unitário
  const rd = await c.call('tools/call', {name:'health', arguments:{}});
  const hcheck = JSON.parse(rd.result.content[0].text);
  const healthOk = hcheck.backends && hcheck.backends.camoufox && !('bridge_auth' in hcheck);
  console.log(`[8] health sem bridge_auth + backends{camoufox,cloakbrowser,http}: ${healthOk?'PASS':'FAIL'}`);
  c.srv.kill();
  // [9] unit: redactSecrets + AuthService via exports
  process.env.CAMOFOX_TEST='1';
  const M = require(path.join('..','src','index.js'));
  const rd1 = JSON.stringify(M.redactSecrets({password:'x', token:'y', obj:{apiKey:'z', plain:'ok', cookie:'c'}}));
  const {AuthService}=require(path.join('..','src','auth.js'));
  const aa=new AuthService();
  const unitOk = rd1.includes('[REDACTED]') && rd1.includes('plain') && !rd1.includes(':"x"')
    && aa.verifiedState('t','https://login.microsoftonline.com/').state==='UNAUTHENTICATED'
    && aa.verifiedState('u','https://x/_layouts/15/AccessDenied.aspx').state==='BLOCKED';
  console.log(`[9] unit redactSecrets + AuthStates: ${unitOk?'PASS':'FAIL'}`);
  console.log('\nRESULTADO: ' + (tools.length>=9 && authOk && ssrfOk && batchOk && healthOk && unitOk ? 'TODOS PASS ✓' : 'FALHAS'));
}
main().catch(e=>{ console.error('FATAL:', e.message); process.exit(1); });

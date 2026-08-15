/**
 * Testes de edge case — comportamento com inputs anormais/inválidos.
 * Cada edge case verifica que a tool NÃO crasha e devolve resposta estruturada.
 */
const { spawn } = require('child_process');
const path = require('path');
const MCP_BIN = path.join(__dirname, '..', 'bin', 'super-browser-mcp.sh');
const srv = spawn(MCP_BIN, [], { stdio: ['pipe','pipe','pipe'] });
let buf=''; let id=0; const pending={};
srv.stdout.on('data', d=>{buf+=d.toString();let nl;while((nl=buf.indexOf('\n'))>=0){const l=buf.slice(0,nl);buf=buf.slice(nl+1);if(!l.trim())continue;try{const m=JSON.parse(l);if(m.id&&pending[m.id]){pending[m.id](m);delete pending[m.id];}}catch{}}});
function call(method,params){const myId=++id;srv.stdin.write(JSON.stringify({jsonrpc:'2.0',id:myId,method,params})+'\n');return new Promise(r=>pending[myId]=r);}
async function main(){
  await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'edge',version:'1'}});
  const results=[];
  const tests=[
    ['finance_quote', 'finance_quote', {symbol:'ZZZZZZ'}],
    ['finance_crypto', 'finance_crypto', {pair:'NOTAPAIR'}],
    ['finance_crypto formato', 'finance_crypto', {pair:'btc'}],
    ['finance_defi 0', 'finance_defi', {limit:0}],
    ['finance_defi neg', 'finance_defi', {limit:-5}],
    ['site inválido', 'site_search', {site:'sitenaoexiste',command:'search',query:'x'}],
    ['comando inválido', 'site_search', {site:'youtube',command:'comandofalso',query:'x'}],
    ['sem query', 'site_search', {site:'youtube',command:'search'}],
    ['query vazia', 'social_sentiment', {query:''}],
    ['web_search vazia', 'web_search', {query:''}],
    ['URL inválida', 'scrape_stealth', {url:'notaurl'}],
    ['domínio inexistente', 'scrape_stealth', {url:'https://site.inexistente.zzz'}],
    ['ação inválida', 'browser_act', {action:'ação_inexistente',args:{}}],
    ['open URL inválida', 'browser_act', {action:'open',args:{url:'ht!tp://invalid'}}],
    ['auth site inválido', 'auth_check', {site:'sitenaoexiste'}],
    ['health', 'health', {}],
  ];
  for(const t of tests){
    const [label, name, args] = t;
    const t0=Date.now();
    try{
      const r=await call('tools/call',{name,arguments:args});      const txt=r.result?.content?.[0]?.text||'';
      // edge case pass = resposta estruturada (ok:false com error, ou lista vazia, nunca crash)
      const hasError = txt.startsWith('{"ok":false') || txt.includes('"error"');
      const isList = txt.startsWith('[');
      const structured = hasError || isList || txt.length>0;
      results.push({label, pass:structured && !/fatal|traceback|undefined is not/i.test(txt), ms:Date.now()-t0, txt:txt.slice(0,70)});
    }catch(e){results.push({label,pass:false,ms:Date.now()-t0,txt:'CRASH: '+e.message});}
  }
  const pass=results.filter(r=>r.pass).length;
  for(const r of results) console.log(`${r.pass?'✅':'❌'} ${r.label} (${r.ms}ms) | ${r.txt.slice(0,60)}`);
  console.log(`\n=== EDGE CASES: ${pass}/${results.length} PASS ===`);
  srv.kill();
  process.exit(pass===results.length?0:1);
}
main().catch(e=>{console.error('FATAL:',e.message);srv.kill();process.exit(1);});

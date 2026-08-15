const { spawn } = require('child_process');
const srv = spawn('node', ['src/index.js'], { cwd: __dirname + '/..', stdio: ['pipe','pipe','pipe'] });
let buf=''; let id=0; const pending={};
srv.stdout.on('data', d=>{ buf+=d.toString(); let nl;
  while((nl=buf.indexOf('\n'))>=0){ const line=buf.slice(0,nl); buf=buf.slice(nl+1);
    if(!line.trim())continue;
    try{ const m=JSON.parse(line); if(m.id&&pending[m.id]){pending[m.id](m);delete pending[m.id];} }catch{} } });
function call(method,params){ const myId=++id; srv.stdin.write(JSON.stringify({jsonrpc:'2.0',id:myId,method,params})+'\n'); return new Promise(r=>pending[myId]=r); }
async function main(){
  await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}});
  const tests=[
    ['finance_quote',{symbol:'NVDA'}],
    ['finance_options',{symbol:'AAPL'}],
    ['finance_crypto',{pair:'ETHUSDT'}],
    ['finance_defi',{limit:3}],
    ['social_sentiment',{query:'AAPL',limit:2}],
    ['web_search',{query:'quantum computing',limit:2}],
    ['health',{}],
  ];
  for(const [name,args] of tests){
    const t0=Date.now();
    try{
      const res=await call('tools/call',{name,arguments:args});
      const raw=res.result?.content?.[0]?.text;
      let summary='?';
      try{ const j=JSON.parse(raw); summary=Array.isArray(j)?(j.length+' itens'):(j.error?('ERRO: '+j.error.slice(0,40)):'ok'); }catch{ summary=String(raw).slice(0,40); }
      console.log(`  ${name}: ${summary} (${Date.now()-t0}ms)`);
    }catch(e){ console.log(`  ${name}: FAIL ${e.message}`); }
  }
  srv.kill();
}
main().catch(e=>{console.error('ERRO:',e.message);srv.kill();});

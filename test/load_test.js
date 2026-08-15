/**
 * Load test do super-browser-mcp (v2 — cliente por chamada + timeout).
 * Cada tools/call usa o seu próprio processo MCP (isolamento real de throughput),
 * com timeout de 60s. Mede throughput, latência p50/p95/max, erros.
 */
const { spawn } = require('child_process');
const path = require('path');
const CONCURRENCY = parseInt(process.argv[2] || '20', 10);
const TOTAL = parseInt(process.argv[3] || '100', 10);
const MCP_BIN = path.join(__dirname, '..', 'bin', 'super-browser-mcp.sh');

const TOOLS = [
  ['web_search', { query: 'MCP server 2026', limit: 2 }],
  ['finance_crypto', { pair: 'BTCUSDT' }],
  ['finance_defi', { limit: 3 }],
  ['health', {}],
];

function callOnce(toolName, args) {
  return new Promise((resolve) => {
    const srv = spawn(MCP_BIN, [], { stdio: ['pipe','pipe','pipe'] });
    let buf=''; let responded=false;
    const timer = setTimeout(() => { cleanup(); resolve({ ok:false, ms:60000, toolName, error:'TIMEOUT 60s' }); }, 60000);
    function cleanup(){ clearTimeout(timer); try{ srv.kill(); }catch{} }
    srv.stdout.on('data', d=>{ buf+=d.toString(); let nl;
      while((nl=buf.indexOf('\n'))>=0){ const line=buf.slice(0,nl); buf=buf.slice(nl+1);
        if(!line.trim())continue;
        try{ const m=JSON.parse(line);
          if(m.id===1 && !responded){ responded=true; srv.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:toolName,arguments:args}})+'\n'); }
          if(m.id===2){ const ms=Date.now()-t0; cleanup(); resolve({ ok: !(m.error), ms, toolName, error: m.error?.message?.slice(0,80) }); }
        }catch{} } });
    srv.on('error', (e)=>{ cleanup(); resolve({ ok:false, ms:Date.now()-t0, toolName, error:e.message }); });
    const t0 = Date.now();
    srv.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'lt',version:'1'}}})+'\n');
  });
}

async function main(){
  const jobs=[];
  for(let i=0;i<TOTAL;i++){ const [tn,args]=TOOLS[i%TOOLS.length]; jobs.push({tn,args}); }
  let idx=0; const results=[];
  const startWall=Date.now();
  async function runner(){ while(idx<jobs.length){ const j=jobs[idx++]; results.push(await callOnce(j.tn, j.args)); } }
  const pool=[]; for(let i=0;i<CONCURRENCY;i++) pool.push(runner());
  await Promise.all(pool);
  const wallMs=Date.now()-startWall;
  const ok=results.filter(r=>r.ok), fail=results.filter(r=>!r.ok);
  const lats=ok.map(r=>r.ms).sort((a,b)=>a-b);
  const p50=lats[Math.floor(lats.length*.5)]||0, p95=lats[Math.floor(lats.length*.95)]||0, max=lats[lats.length-1]||0;
  const sum=lats.reduce((a,b)=>a+b,0), avg=ok.length?sum/ok.length:0;
  const byTool={}; for(const t of results){ byTool[t.toolName]=byTool[t.toolName]||{ok:0,fail:0,sum:0}; byTool[t.toolName].ok+=t.ok?1:0; byTool[t.toolName].fail+=t.ok?0:1; byTool[t.toolName].sum+=t.ms; }
  console.log(JSON.stringify({
    config:{concurrency:CONCURRENCY,total:TOTAL},
    results:{
      ok:ok.length, fail:fail.length, error_rate_pct:+(fail.length*100/TOTAL).toFixed(1),
      wall_s:+(wallMs/1000).toFixed(1), throughput_ok_per_s:+(ok.length/(wallMs/1000)).toFixed(2),
      latency_ms:{avg:+avg.toFixed(0),p50,p95,max},
    },
    per_tool:Object.fromEntries(Object.entries(byTool).map(([k,v])=>[k,{ok:v.ok,fail:v.fail,avg_ms:+(v.sum/v.ok).toFixed(0)}])),
    sample_errors:fail.slice(0,5).map(r=>`${r.toolName}:${(r.error||'').slice(0,60)}`),
  },null,1));
}
main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});

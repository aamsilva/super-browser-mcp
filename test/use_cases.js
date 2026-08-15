/**
 * 20 use cases reais — cenários de uso práticos cobrindo todas as 13 tools.
 * Cada um valida que a resposta é útil (não só que não crasha).
 */
const { spawn } = require('child_process');
const path = require('path');
const srv = spawn(path.join(__dirname,'..','bin','super-browser-mcp.sh'), [], { stdio:['pipe','pipe','pipe'] });
let buf=''; let id=0; const pending={};
srv.stdout.on('data', d=>{buf+=d.toString();let nl;while((nl=buf.indexOf('\n'))>=0){const l=buf.slice(0,nl);buf=buf.slice(nl+1);if(!l.trim())continue;try{const m=JSON.parse(l);if(m.id&&pending[m.id]){pending[m.id](m);delete pending[m.id];}}catch{}}});
function call(method,params){const myId=++id;srv.stdin.write(JSON.stringify({jsonrpc:'2.0',id:myId,method,params})+'\n');return new Promise(r=>pending[myId]=r);}
async function run(name,args){
  const t0=Date.now();
  try{const r=await call('tools/call',{name,arguments:args});const txt=r.result?.content?.[0]?.text||'';
    let ok=false,sample='';
    try{const j=JSON.parse(txt);ok=Array.isArray(j)?j.length>0:(j.ok!==false&&!j.error);sample=Array.isArray(j)?JSON.stringify(j[0]).slice(0,55):JSON.stringify(j).slice(0,55);}catch{ok=!!txt&&!txt.startsWith('{"ok":false');sample=txt.slice(0,55);}
    return {ok,ms:Date.now()-t0,sample};
  }catch(e){return {ok:false,ms:Date.now()-t0,sample:'CRASH: '+e.message};}
}
async function main(){
  await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'uc',version:'1'}});
  const results=[];
  const tests=[
    ['finance_quote TSLA', 'finance_quote', {symbol:'TSLA'}],
    ['finance_options AAPL', 'finance_options', {symbol:'AAPL'}],
    ['finance_crypto ETHUSDT', 'finance_crypto', {pair:'ETHUSDT'}],
    ['finance_defi top 5', 'finance_defi', {limit:5}],
    ['social_sentiment TSLA', 'social_sentiment', {query:'TSLA',limit:2}],
    ['web_search MCP', 'web_search', {query:'MCP server architecture',limit:3}],
    ['site_search youtube MCP', 'site_search', {site:'youtube',command:'search',query:'MCP',limit:2}],
    ['site_search twitter trending', 'site_search', {site:'twitter',command:'trending',limit:2}],
    ['site_search google news AI', 'site_search', {site:'google',command:'news',query:'AI',limit:2}],
    ['site_search xueqiu hot', 'site_search', {site:'xueqiu',command:'hot-stock',limit:2}],
    ['site_search bbc news', 'site_search', {site:'bbc',command:'news',limit:2}],
    ['site_search hn top', 'site_search', {site:'hackernews',command:'top',limit:2}],
    ['browser_browse HN', 'browser_browse', {url:'https://news.ycombinator.com'}],
    ['scrape_stealth expresso', 'scrape_stealth', {url:'https://expresso.pt'}],
    ['auth_status', 'auth_status', {}],
    ['auth_check github', 'auth_check', {site:'github'}],
    ['health', 'health', {}],
    ['browser_act open+extract', 'browser_act', {action:'open',args:{url:'https://example.com'}}],
    ['browser_act stateful flow', 'browser_act', {action:'extract'}],
    ['browser_act close', 'browser_act', {action:'close'}],
  ];
  for(const [label,name,args] of tests){
    const r=await run(name,args);
    results.push({label,...r});
  }
  const pass=results.filter(r=>r.ok).length;
  for(const r of results) console.log(`${r.ok?'✅':'❌'} ${r.label} (${r.ms}ms) | ${r.sample}`);
  console.log(`\n=== USE CASES: ${pass}/${results.length} PASS ===`);
  srv.kill();process.exit(pass===results.length?0:1);
}
main().catch(e=>{console.error('FATAL:',e.message);srv.kill();process.exit(1);});

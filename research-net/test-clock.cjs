const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require('../node_modules/playwright');
(async()=>{
 const root=path.resolve(__dirname,'..');
 const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
  if(!file.startsWith(root+'/'))return res.writeHead(403).end();
  const types={'.js':'text/javascript','.html':'text/html','.wasm':'application/wasm','.swf':'application/x-shockwave-flash'};
  fs.readFile(file,(e,data)=>{res.writeHead(e?404:200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(e?'missing':data);});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try{
  const pages=await Promise.all([browser.newPage(),browser.newPage()]);
  for(const p of pages){p.on('pageerror',e=>console.log('PAGE ERROR',String(e)));p.on('console',m=>{if(m.type()==='error')console.log('ERROR',m.text());});}
  await Promise.all(pages.map(p=>p.goto('http://127.0.0.1:'+server.address().port+'/research-net/clock-probe.html')));
  await Promise.all(pages.map(p=>p.evaluate(()=>ready)));
  console.log('READY',await pages[0].evaluate(()=>({clock:GunMayhemClock.snapshot(),traces})));
  const advance=async(p,n)=>p.evaluate(n=>{for(let i=0;i<n;i++)GunMayhemClock.advance();return{clock:GunMayhemClock.snapshot(),count:traces.filter(t=>!t.startsWith('timer:')).length,last:traces.slice(-6),now:performance.now(),date:Date.now()};},n);
  console.log('FIRST',await advance(pages[0],1));
  console.log('SECOND',await advance(pages[0],1));
  console.log('ONE MINUTE',await advance(pages[0],2098));
  console.log('OTHER PACING',await advance(pages[1],1050));
  await new Promise(r=>setTimeout(r,180));
  console.log('OTHER PACING END',await advance(pages[1],1050));
  const traces=await Promise.all(pages.map(p=>p.evaluate(()=>window.traces)));
  if(JSON.stringify(traces[0])!==JSON.stringify(traces[1]))throw new Error('Traces diverged');
  const count=traces[0].filter(t=>!t.startsWith('timer:')).length;
  if(count!==2099)throw new Error('Expected 2099 enterFrame ticks; got '+count);
  console.log('IDENTICAL',count,'simulated movie frames across two independently paced Ruffle instances');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});

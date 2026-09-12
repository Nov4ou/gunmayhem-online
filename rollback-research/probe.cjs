'use strict';
// An isolated experiment. Production files and the installed Ruffle stay untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const frames = Number(process.env.GM_ROLLBACK_FRAMES || 350);
const rollbackDepth = Number(process.env.GM_ROLLBACK_DEPTH || 7);
const map = Number(process.env.GM_ROLLBACK_MAP || 1);
const reserve = Number(process.env.GM_ROLLBACK_RESERVE || 64);
const usePages = process.env.GM_ROLLBACK_PAGES || '';
const effects = process.env.GM_ROLLBACK_EFFECTS || '';
const branchMode = process.env.GM_ROLLBACK_BRANCH !== '0';
const replayRenderStride = Number(process.env.GM_REPLAY_RENDER_STRIDE || 0);
const out = path.join(__dirname, 'results', process.env.GM_ROLLBACK_LABEL || 'probe');
const html = `<!doctype html><meta charset="utf-8">
<script src="/experiment/state/snapshot.js"></script>
<script src="/experiment/state/clock.js"></script>
${usePages ? '<script src="/experiment/' + (usePages === 'direct' ? 'pages-direct' : 'pages') + '.js"></script>' : ''}
${effects ? effects.split(',').map(file=>'<script src="/experiment/effects/' + file + '"></script>').join('') : ''}
<script>window.RufflePlayer={config:{autoplay:'on',unmuteOverlay:'hidden',splashScreen:false,contextMenu:'off',allowScriptAccess:true,openUrlMode:'deny',warnOnUnsupportedContent:false${process.env.GM_RENDERER ? ',preferredRenderer:'+JSON.stringify(process.env.GM_RENDERER):''}}};</script>
<script src="/ruffle/ruffle.js"></script>
<style>html,body,#game,ruffle-player{margin:0;width:100%;height:100%;display:block}</style>
<div id="game"></div><script>
window.bridgeReady=false;window.netReady=()=>{bridgeReady=true};
window.errors=[];window.addEventListener('error',e=>errors.push(e.message));
window.loaded=(async()=>{
 window.player=RufflePlayer.newest().createPlayer();document.querySelector('#game').append(player);
 const data=new Uint8Array(await (await fetch('/gunmayhem-net.swf')).arrayBuffer());
 await player.ruffle(1).load({data,swfFileName:'gunmayhem-net.swf',allowScriptAccess:true});
 for(let i=0;i<100&&!bridgeReady;i++){GunMayhemClock.advance();await new Promise(r=>setTimeout(r,0));}
 if(!bridgeReady)throw new Error('The movie did not register its bridge');
 await RuffleRollback.pagesReady;
 return {clock:GunMayhemClock.snapshot(),rollback:RuffleRollback.inspect(),audio:window.RuffleRollbackAudio?.diagnostics()};
})();
window.call=(name,...args)=>player.ruffle(1).callExternalInterface(name,...args);
window.begin=config=>{RuffleRollback.reserveMemory(${reserve});if(call('netStart',config)!==true)throw new Error('netStart failed');return call('netState')};
window.run=(inputs,replaying=false,readState=true)=>{GunMayhemClock.setReplay(replaying);for(const [frame,masks] of inputs){call('netInput',frame,masks);GunMayhemClock.advance({render:!replaying||frame===inputs.at(-1)[0]||(${replayRenderStride}>0&&frame%${replayRenderStride}===0)});}GunMayhemClock.setReplay(false);if(readState)return call('netState')};
window.replay=inputs=>{
 const saved=RuffleRollback.capture();const t=GunMayhemClock.realNow();
 const draws=()=>window.RuffleRollbackGL?.diagnostics().methodCounts.drawElementsInstanced||0;
 const beforeDraws=draws();
 run(inputs.map(([f,m])=>[f,[m[0]^10,m[1]^25,m[2],m[3]]]),false,false);
 const predictedDraws=draws();
 const predicted=GunMayhemClock.realNow();
 RuffleRollback.restore(saved);
 const restored=GunMayhemClock.realNow();
 run(inputs,true,false);
 const recomputed=GunMayhemClock.realNow();
 const state=call('netState');RuffleRollback.release(saved);
 return {state,ms:GunMayhemClock.realNow()-t,timing:{predict:predicted-t,restore:restored-predicted,replay:recomputed-restored,readState:GunMayhemClock.realNow()-recomputed,predictDraws:predictedDraws-beforeDraws,replayDraws:draws()-predictedDraws},rollback:RuffleRollback.inspect(),pages:RuffleRollback.memoryStore?.inspect(),gl:window.RuffleRollbackGL?.diagnostics()};
};
</script>`;
function serve(req,res){
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/test'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(html);}
 const relative=url.pathname.startsWith('/ruffle/')?'/node_modules/@ruffle-rs/ruffle/'+url.pathname.slice(8):url.pathname.startsWith('/experiment/')?'/rollback-research/'+url.pathname.slice(12):'/public'+url.pathname;
 const filename=path.resolve(root,'.'+relative);
 if(!filename.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 fs.readFile(filename,(error,data)=>{
  try {
   if(error)throw error;
   const {patchCore,patchWasm}=require('./state/patch.cjs');
   if(path.basename(filename)==='core.ruffle.c80159b526e567babaf5.js')data=Buffer.from(patchCore(data.toString()));
   if(path.basename(filename)==='826bb0938097485a2c9d.wasm')data=patchWasm(data);
   const types={'.js':'text/javascript','.wasm':'application/wasm','.swf':'application/x-shockwave-flash'};
   res.writeHead(200,{'Content-Type':types[path.extname(filename)]||'application/octet-stream'});res.end(data);
  } catch(e){res.writeHead(500);res.end(String(e));console.error(String(e));}
 });
}
function masks(frame){return [0,1,2,3].map(p=>p>1?0:((Math.floor((frame+p*83)/117)%2?2:8)|((frame+p*7)%43<4?1:0)|(frame%(7+p)<5?16:0)|((frame+p*13)%79<2?32:0)));}
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const report={started:new Date().toISOString(),frames,rollbackDepth,map,effects,branchMode,replayRenderStride,samples:[],browserErrors:[],consoleErrors:[],webglWarnings:[]};
 const server=http.createServer(serve);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.GM_BROWSER_BIN||undefined,args:['--autoplay-policy=no-user-gesture-required',...(process.env.GM_GPU==='1'?['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']:[])]});
 try {
  const contexts=await Promise.all([0,1].map(()=>browser.newContext({viewport:{width:900,height:600}})));
  const pages=await Promise.all(contexts.map(c=>c.newPage()));
  pages.forEach((p,i)=>{p.on('pageerror',e=>report.browserErrors.push({client:i,message:String(e)}));p.on('console',m=>{const message=m.text();if(message.includes('Used renderer:'))console.log('RENDERER',i,message);if(m.type()==='error'&&report.consoleErrors.length<30)report.consoleErrors.push({client:i,message});if(/already deleted|INVALID_OPERATION/i.test(message)&&report.webglWarnings.length<30)report.webglWarnings.push({client:i,message});});});
  await Promise.all(pages.map(p=>p.goto('http://127.0.0.1:'+server.address().port+'/test')));
  report.loaded=await Promise.all(pages.map(p=>p.evaluate(()=>loaded)));console.log('BOOT',JSON.stringify(report.loaded));
  const config={map,players:2,lives:99,seed:15481};
  const initial=await Promise.all(pages.map(p=>p.evaluate(c=>begin(c),config)));assert.deepEqual(initial[0],initial[1]);
  for(let start=1;start<=frames;start+=rollbackDepth){
   const end=Math.min(start+rollbackDepth-1,frames);
   const inputs=Array.from({length:end-start+1},(_,i)=>[start+i,masks(start+i)]);
   const [normal,replayed]=await Promise.all([
    pages[0].evaluate(x=>run(x),inputs),
    branchMode
     ? pages[1].evaluate(x=>replay(x),inputs)
     : pages[1].evaluate(x=>({state:run(x),ms:0,timing:null,rollback:RuffleRollback.inspect(),pages:RuffleRollback.memoryStore?.inspect(),gl:window.RuffleRollbackGL?.diagnostics()}),inputs),
   ]);
   const sample={frame:end,ms:replayed.ms,timing:replayed.timing,rollback:replayed.rollback,pages:replayed.pages,gl:replayed.gl,checksum:normal.checksum};report.samples.push(sample);
   try{assert.deepEqual(replayed.state,normal);}catch(error){report.divergence={frame:end,normal,replayed:replayed.state};throw error;}
   if(end%35===0||end===frames)console.log('MATCH',JSON.stringify(sample));
  }
  await Promise.all(pages.map((p,i)=>p.screenshot({path:path.join(out,'final-'+i+'.png')})));
  assert.equal(report.browserErrors.length,0,JSON.stringify(report.browserErrors));
  assert.equal(report.webglWarnings.length,0,JSON.stringify(report.webglWarnings));
  report.passed=true;console.log('PASS',frames,'frames with',branchMode?'repeated '+rollbackDepth+' frame rollback':'two independent normal renderers');
 } catch(error){report.error=String(error);report.failedDiagnostics=await Promise.all(browser.contexts().flatMap(c=>c.pages()).map(p=>p.evaluate(()=>({gl:window.RuffleRollbackGL?.diagnostics(),audio:window.RuffleRollbackAudio?.diagnostics()})).catch(()=>null)));console.log('FAILED_DIAGNOSTICS',JSON.stringify(report.failedDiagnostics));throw error;}
 finally{report.finished=new Date().toISOString();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});

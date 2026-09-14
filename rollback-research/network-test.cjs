'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const clientCount=Number(process.env.GM_NETWORK_CLIENTS||2),duration=Number(process.env.GM_NETWORK_SECONDS||12);
const gameMode=process.env.GM_GAME_MODE||'last-man-standing';
const testNames=process.env.GM_TEST_NAMES?JSON.parse(process.env.GM_TEST_NAMES):Array.from({length:clientCount},(_,i)=>'Rollback Test '+(i+1));
const testProfiles=process.env.GM_TEST_PROFILES?JSON.parse(process.env.GM_TEST_PROFILES):[{color:1,shirt:15,hat:24},{color:10,shirt:2,hat:3},{color:7,shirt:8,hat:15},{color:4,shirt:11,hat:18}];
const configuredDelays=(process.env.GM_NETWORK_DELAYS||process.env.GM_NETWORK_DELAY||'75').split(',').map(Number);
const delays=Array.from({length:clientCount},(_,i)=>configuredDelays[i]??configuredDelays.at(-1));
assert(Number.isInteger(clientCount)&&clientCount>=2&&clientCount<=4,'Expected two to four browser clients');
assert(['last-man-standing','gun-game'].includes(gameMode),'Expected last-man-standing or gun-game');
assert(delays.every(delay=>Number.isFinite(delay)&&delay>=0),'Network delays must be non-negative numbers');
const out=path.join(__dirname,'results',process.env.GM_NETWORK_LABEL||'network');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.GM_BROWSER_BIN||undefined,args:['--autoplay-policy=no-user-gesture-required',...(process.env.GM_GPU==='1'?['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']:[])]});
 const report={gameMode,delayEachDirectionMs:delays,duration,clientCount,errors:[],console:[],webglWarnings:[],samples:[]};
 fs.mkdirSync(out,{recursive:true});
 try{
  const pages=[];
  for(let i=0;i<clientCount;i++){
   const context=await browser.newContext({viewport:{width:1000,height:850}}),page=await context.newPage();pages.push(page);
   page.on('pageerror',e=>report.errors.push({client:i,error:String(e)}));
   page.on('console',message=>{const text=message.text();if(message.type()==='error')report.console.push({client:i,message:text});if(/already deleted|INVALID_OPERATION/i.test(text))report.webglWarnings.push({client:i,message:text});});
   await page.addInitScript(({delay})=>{
    const Native=window.WebSocket;
    window.WebSocket=class extends Native{
     constructor(...args){super(...args);this.listener=null;super.addEventListener('message',event=>{const handler=this.listener;setTimeout(()=>handler?.call(this,event),delay);});}
     set onmessage(handler){this.listener=handler;}get onmessage(){return this.listener;}
     send(data){setTimeout(()=>{if(this.readyState===Native.OPEN)super.send(data);},delay);}
    };
    window.testStates={};window.frameTimes=[];window.runtimeMessages=[];
    window.addEventListener('message',e=>{if(e.data?.source!=='gunmayhem-runtime')return;if(e.data.type==='state')testStates[e.data.frame]=e.data.state;if(e.data.type==='rendered')frameTimes.push([performance.now(),e.data.frame]);if(e.data.type==='error'||e.data.type==='waiting')runtimeMessages.push({at:performance.now(),...e.data});});
   },{delay:delays[i]});
   await page.goto(process.env.GAME_URL||'http://127.0.0.1:3003/');
   await page.waitForFunction(()=>document.getElementById('connection').textContent==='Connected');
   await page.locator('#name').fill(testNames[i]);
  }
  await pages[0].locator('#create').click();await pages[0].locator('#room-title').waitFor();
  if(gameMode!=='last-man-standing')await pages[0].locator('#mode').selectOption(gameMode);
  const room=await pages[0].locator('#room-title').textContent();
  for(const page of pages.slice(1)){await page.locator('#room-code').fill(room);await page.locator('button[type="submit"]').click();}
  await pages[0].waitForFunction(count=>[...document.querySelectorAll('#players li')].filter(item=>!item.classList.contains('empty')).length===count,clientCount);
  for(let i=0;i<clientCount;i++){
   const profile=testProfiles[i];await pages[i].evaluate(profile=>send('profile',profile),profile);
  }
  await Promise.all(pages.map(page=>page.waitForFunction(expected=>JSON.stringify(gunmayhemDiagnostics().profiles)===JSON.stringify(expected),testProfiles.slice(0,clientCount))));
  await pages[0].waitForFunction(()=>!document.getElementById('start').disabled);await pages[0].locator('#start').click();
  await Promise.all(pages.map(p=>p.waitForFunction(()=>gunmayhemDiagnostics().started,{},{timeout:90000})));
  if(gameMode==='gun-game')for(const page of pages){const frame=page.frames().find(candidate=>candidate.url().includes('runtime.html'));assert(frame);await frame.waitForFunction(count=>{const players=call('netState').players.slice(0,count);return players.length===count&&players.every(Boolean);},clientCount);const players=await frame.evaluate(()=>call('netState').players);assert(players.slice(0,clientCount).every(player=>player.currentlevel===1&&player.currentgun===44),'Reverse Gun Game did not start with weapon 44');}
  for(let i=0;i<duration*2;i++){
   await Promise.all(pages.map((p,slot)=>p.evaluate(({i,slot})=>{key('KeyJ',i%3!==0);key(slot%2?'KeyA':'KeyD',i%4<2);key('KeyW',i%4===0);key('KeyK',i%7===0);},{i,slot})));
   await new Promise(r=>setTimeout(r,500));
  }
  await Promise.all(pages.map(p=>p.evaluate(()=>release())));await new Promise(r=>setTimeout(r,1500));
  report.clients=await Promise.all(pages.map(async(p,i)=>{
   const parent=await p.evaluate(()=>({diagnostics:gunmayhemDiagnostics(),states:testStates,frames:frameTimes,messages:runtimeMessages,notice:document.getElementById('notice').textContent,overlay:document.getElementById('overlay-text').textContent,previewActive:Boolean(document.getElementById('character-preview-frame'))}));
   const runtimeFrame=p.frames().find(f=>f.url().includes('runtime.html'));
   const runtime=runtimeFrame?await runtimeFrame.evaluate(()=>{const state=call('netState');return{diagnostics:rollbackDiagnostics(),nativeMode:state.mode,nativeProfiles:state.profiles,nativeNameFields:state.nameFields};}):null;
   await p.screenshot({path:path.join(out,`client-${i}.png`)});
   return{parent,runtime};
  }));
  const shared=Object.keys(report.clients[0].parent.states).filter(f=>report.clients.every(client=>f in client.parent.states));
  assert(shared.length>=3,'Too few confirmed states');
  for(const f of shared)for(const client of report.clients.slice(1))assert.deepEqual(report.clients[0].parent.states[f],client.parent.states[f],'State mismatch at '+f);
  for(const c of report.clients){
   assert(c.parent.diagnostics.started,JSON.stringify(c.parent));
   assert.equal(c.parent.previewActive,false,'The lobby-only character preview must be released during a match');
   assert.equal(c.runtime?.nativeMode,gameMode==='gun-game'?4:1,'The SWF started the wrong original game mode');
   assert.deepEqual(c.runtime?.nativeProfiles.slice(0,clientCount).map(({color,shirt,hat})=>({color,shirt,hat})),testProfiles.slice(0,clientCount),'The SWF received the wrong character appearance');
   assert.deepEqual(c.runtime?.nativeProfiles.slice(0,clientCount).map(profile=>profile.name),testNames.slice(0,clientCount),'The SWF received the wrong player names');
   assert.deepEqual(c.runtime?.nativeNameFields.slice(0,clientCount).map(field=>field?.text),testNames.slice(0,clientCount),'The in-game name tags received the wrong text');
   assert(c.runtime?.nativeNameFields.slice(0,clientCount).every(field=>field&&!field.embedFonts&&field.font==='_sans'&&field.textWidth>0),'Player names must use a CJK-capable device font');
   assert(c.runtime,'Game iframe was removed: '+JSON.stringify(c.parent));
   assert.equal(c.runtime.diagnostics.mode,'lockstep');
   assert.equal(c.runtime.diagnostics.metrics.rollbacks,0,'Production lockstep must not replay predicted history');
   assert(c.runtime.diagnostics.metrics.framesSimulated>0,'Lockstep test did not simulate authoritative frames');
   const times=c.parent.frames;
   assert(times.length>2,'Too few rendered frame samples');
   c.averageFPS=(times.at(-1)[1]-times[0][1])*1000/(times.at(-1)[0]-times[0][0]);
   c.maxFrameGapMs=Math.max(...times.slice(1).map((x,i)=>x[0]-times[i][0]));
  }
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.webglWarnings,[]);report.sharedCheckpoints=shared.length;report.passed=true;
  console.log(JSON.stringify(report.clients.map(c=>({fps:c.averageFPS,maxGapMs:c.maxFrameGapMs,runtime:c.runtime})),null,2));
  await pages[0].locator('#stop').click();
 }catch(error){report.error=String(error);throw error;}
 finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

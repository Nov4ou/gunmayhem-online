'use strict';
let player,ready=false,sequence=0,resultScreen=false,active=false,localMask=0;
let timeline,timer,match,inputDelayFrames=0,graceMs=0,lastInputFrameSent=0,lastFrameArrivalAt=0,botMode='',botSlot=0;
const nativeTimeout=window.setTimeout.bind(window);
const frameBudgetMs=1000/35;
const maxCatchupPerCycle=2;
const spikeRecorder={ring:[],events:[],capture:null,report:null,lastAudio100:0,lastAudioDrop:0,lastFallbackFrames:0,cooldownUntil:0};
const spikePreSamples=280;
const spikePostMs=2000;
const spikeCooldownMs=5000;
const inputLatency={pending:[],byFrame:new Map(),awaitingPresentation:[],samples:[],rafPending:false,missed:0,fallbackMisses:0,lastMs:null,medianMs:null,p95Ms:null};
const inputLatencyWindow=60;
const epochNow=()=>performance.timeOrigin+GunMayhemClock.realNow();
const metrics={
 mode:'lockstep',rollbacks:0,replayedFrames:0,captures:0,restores:0,
 framesSimulated:0,catchupFrames:0,renderedFrames:0,skippedRenderFrames:0,
 fallbackFrames:0,fallbackInputs:0,localFallbacks:0,remoteFallbacks:0,
 inputPacketsSent:0,inputRevisionsSent:0,inputFramesSkipped:0,receivedFrames:0,duplicateFrames:0,staleFrames:0,
 tickMs:0,maxTickMs:0,inputMs:0,maxInputMs:0,advanceMs:0,maxAdvanceMs:0,
 renderedAdvanceMs:0,maxRenderedAdvanceMs:0,skippedAdvanceMs:0,maxSkippedAdvanceMs:0,
 checkStateMs:0,maxCheckStateMs:0,maxBufferedFrames:0,maxBehindMs:0,
 frameArrivalGapMs:0,maxFrameArrivalGapMs:0
};
function send(type,data={}){parent.postMessage({source:'gunmayhem-runtime',type,...data},location.origin);}
function spikeEvent(type,data={}){
 const event={wallMs:Date.now(),frame:sequence,type,...data};
 spikeRecorder.events.push(event);
 if(spikeRecorder.events.length>100)spikeRecorder.events.shift();
 if(spikeRecorder.capture)spikeRecorder.capture.events.push(event);
}
function inputLatencyDiagnostics(){return {count:inputLatency.samples.length,lastMs:inputLatency.lastMs,medianMs:inputLatency.medianMs,p95Ms:inputLatency.p95Ms,pending:inputLatency.pending.length,scheduled:[...inputLatency.byFrame.values()].reduce((n,row)=>n+row.length,0),awaitingPresentation:inputLatency.awaitingPresentation.length,missed:inputLatency.missed,fallbackMisses:inputLatency.fallbackMisses};}
function resetInputLatency(){inputLatency.pending.length=0;inputLatency.byFrame.clear();inputLatency.awaitingPresentation.length=0;inputLatency.samples.length=0;inputLatency.rafPending=false;inputLatency.missed=0;inputLatency.fallbackMisses=0;inputLatency.lastMs=inputLatency.medianMs=inputLatency.p95Ms=null;}
function queueInputLatencyProbe(probe){
 if(botMode||!probe||!Number.isInteger(probe.id)||!Number.isFinite(probe.startedAtMs)||!Number.isInteger(probe.bit)||probe.bit<1||probe.bit>32)return;
 inputLatency.pending.push({id:probe.id,startedAtMs:probe.startedAtMs,bit:probe.bit,code:String(probe.code||'')});
 if(inputLatency.pending.length>16){inputLatency.pending.shift();inputLatency.missed++;}
}
function pruneInputLatencyProbes(mask){
 if(!inputLatency.pending.length)return;
 const kept=[];for(const probe of inputLatency.pending){if(mask&probe.bit)kept.push(probe);else inputLatency.missed++;}inputLatency.pending=kept;
}
function scheduleInputLatencyProbes(frame,mask){
 if(!inputLatency.pending.length)return;
 const assigned=[],kept=[];
 for(const probe of inputLatency.pending){if(mask&probe.bit)assigned.push({...probe,targetFrame:frame});else kept.push(probe);}
 inputLatency.pending=kept;if(assigned.length)inputLatency.byFrame.set(frame,[...(inputLatency.byFrame.get(frame)||[]),...assigned]);
}
function percentile(sorted,p){return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*p)-1))];}
function publishInputLatency(probes,presentedAtMs,presentedFrame){
 for(const probe of probes){
  const value=Math.max(0,presentedAtMs-probe.startedAtMs);inputLatency.samples.push(value);if(inputLatency.samples.length>inputLatencyWindow)inputLatency.samples.shift();
  inputLatency.lastMs=value;
 }
 if(!inputLatency.samples.length)return;
 const sorted=[...inputLatency.samples].sort((a,b)=>a-b);
 inputLatency.medianMs=percentile(sorted,.5);inputLatency.p95Ms=percentile(sorted,.95);
 send('inputLatency',{sampleMs:inputLatency.lastMs,medianMs:inputLatency.medianMs,p95Ms:inputLatency.p95Ms,count:inputLatency.samples.length,presentedFrame});
}
function scheduleInputLatencyPresentation(){
 if(inputLatency.rafPending||!inputLatency.awaitingPresentation.length)return;inputLatency.rafPending=true;
 requestAnimationFrame(()=>{inputLatency.rafPending=false;if(!inputLatency.awaitingPresentation.length)return;const probes=inputLatency.awaitingPresentation.splice(0);publishInputLatency(probes,epochNow(),sequence);});
}
function consumeInputLatencyFrame(input,catchup){
 const probes=inputLatency.byFrame.get(input.frame);if(probes){
  inputLatency.byFrame.delete(input.frame);const localFallback=input.fallbackSlots.includes(timeline.localSlot);
  for(const probe of probes){if(localFallback||!(input.masks[timeline.localSlot]&probe.bit)){inputLatency.missed++;if(localFallback)inputLatency.fallbackMisses++;continue;}inputLatency.awaitingPresentation.push({...probe,simulatedFrame:input.frame,simulatedAtMs:epochNow()});}
 }
 if(!catchup)scheduleInputLatencyPresentation();
}
function baseDiagnostics(){return {
 mode:'lockstep',sequence,active,confirmed:timeline?.frame??0,
 metrics:{...metrics,inputDelayFrames,graceMs,frameBudgetMs,bufferedFrames:timeline?.bufferedFrames??0,botMode,botActive:Boolean(botMode)},
 checkpointCount:0,
 memory:RuffleRollback.memoryStore?.inspect?.()??null,
 audio:RuffleRollbackAudio.diagnostics(),
 gl:window.RuffleRollbackGL?.diagnostics?.()??null,
 inputLatency:inputLatencyDiagnostics()
};}
function finishSpikeCapture(){
 const capture=spikeRecorder.capture;if(!capture)return;
 spikeRecorder.capture=null;
 const report={
  schema:'gunmayhem-spike-v1',capturedAt:new Date().toISOString(),match,trigger:capture.trigger,
  environment:{userAgent:navigator.userAgent,platform:navigator.platform,visibility:document.visibilityState,devicePixelRatio:window.devicePixelRatio},
  config:{inputDelayFrames,graceMs,frameBudgetMs,botMode,slot:timeline?.localSlot??null},
  samples:[...capture.pre,...capture.post],events:capture.events,diagnostics:baseDiagnostics()
 };
 spikeRecorder.report=report;
 send('spikeCaptured',{summary:{frame:capture.trigger.frame,reasons:capture.trigger.reasons,capturedAt:report.capturedAt}});
}
function recordSpikeSample(tickMs,advanceMs,catchup){
 const audio=RuffleRollbackAudio.diagnostics();
 const gl=window.RuffleRollbackGL?.diagnostics?.()??null;
 const buffered=timeline?.bufferedFrames??0;
 const behindMs=Math.max(0,buffered-1)*frameBudgetMs;
 const dAudio100=Math.max(0,(audio?.lateGte100Ms??0)-spikeRecorder.lastAudio100);
 const dAudioDrop=Math.max(0,(audio?.lateDropped??0)-spikeRecorder.lastAudioDrop);
 const dFallback=Math.max(0,metrics.fallbackFrames-spikeRecorder.lastFallbackFrames);
 spikeRecorder.lastAudio100=audio?.lateGte100Ms??0;
 spikeRecorder.lastAudioDrop=audio?.lateDropped??0;
 spikeRecorder.lastFallbackFrames=metrics.fallbackFrames;
 const sample={
  wallMs:Date.now(),frame:sequence,tickMs,advanceMs,catchup:Boolean(catchup),bufferedFrames:buffered,behindMs,
  fallbackFrames:metrics.fallbackFrames,fallbackInputs:metrics.fallbackInputs,catchupFrames:metrics.catchupFrames,
  dFallback,dAudio100,dAudioDrop,audioWorstLateMs:audio?.worstLateMs??0,
  audioLateSubmissions:audio?.lateSubmissions??0,audioLateDropped:audio?.lateDropped??0,
  glResources:gl?.resources??0,glPendingDeletes:gl?.pendingDeletes??0
 };
 spikeRecorder.ring.push(sample);if(spikeRecorder.ring.length>spikePreSamples)spikeRecorder.ring.shift();
 if(spikeRecorder.capture){
  spikeRecorder.capture.post.push(sample);
  if(sample.wallMs>=spikeRecorder.capture.untilWallMs)finishSpikeCapture();
  return;
 }
 const reasons=[];
 if(tickMs>60)reasons.push(`tick ${Math.round(tickMs)}ms`);
 if(advanceMs>60)reasons.push(`advance ${Math.round(advanceMs)}ms`);
 if(behindMs>100)reasons.push(`behind ${Math.round(behindMs)}ms`);
 if(buffered>=5)reasons.push(`buffered ${buffered} frames`);
 if(dAudio100>0)reasons.push(`audio >=100ms +${dAudio100}`);
 if(dAudioDrop>0)reasons.push(`audio drop +${dAudioDrop}`);
 if(dFallback>1)reasons.push(`fallback +${dFallback}`);
 const now=Date.now();
 if(reasons.length&&now>=spikeRecorder.cooldownUntil){
  spikeRecorder.cooldownUntil=now+spikeCooldownMs;
  spikeRecorder.capture={trigger:{wallMs:now,frame:sequence,reasons},pre:[...spikeRecorder.ring],post:[],events:[...spikeRecorder.events],untilWallMs:now+spikePostMs};
 }
}
window.netReady=()=>{ready=true;send('ready');};
function call(name,...args){return player.ruffle(1).callExternalInterface(name,...args);}
function fail(error){active=false;clearTimeout(timer);send('error',{message:error.message});}
function sendLocal(frame,mask,revision=false){
 scheduleInputLatencyProbes(frame,mask);
 const packet=timeline.makeLocalInput(frame,mask);
 send('input',{packet});
 metrics.inputPacketsSent++;if(revision)metrics.inputRevisionsSent++;
 lastInputFrameSent=Math.max(lastInputFrameSent,frame);
}
function localInputForFrame(frame){return botMode?GunMayhemRollback.botInputMask(frame,botMode,botSlot):localMask;}
function seedLocalInputs(){
 // Frames before the input-delay horizon are intentionally neutral. The first
 // live sample is scheduled after that horizon, giving the round trip through
 // the relay time to finish before the authoritative frame deadline.
 for(let frame=1;frame<=inputDelayFrames;frame++)sendLocal(frame,botMode?localInputForFrame(frame):0);
 sendLocal(inputDelayFrames+1,localInputForFrame(inputDelayFrames+1));
}
function scheduleLocalInput(serverFrame){
 const target=serverFrame+inputDelayFrames+1;
 if(target<=lastInputFrameSent)return;
 const gap=target-lastInputFrameSent;
 // Under ordinary play there is exactly one new target per finalized frame.
 // After a suspended tab, do not flood hundreds of obsolete packets; those old
 // frames have already been neutral-finalized by the server. Resume at the
 // current future horizon instead.
 if(gap>8){metrics.inputFramesSkipped+=gap-1;sendLocal(target,localInputForFrame(target));return;}
 while(lastInputFrameSent<target){const frame=lastInputFrameSent+1;sendLocal(frame,localInputForFrame(frame));}
}
function reviseLocalInputNow(){
 // The normal scheduler pre-submits the current future-horizon frame. If the
 // player changes a control before that frame is finalized, revise that pending
 // row immediately instead of waiting for the next 35 Hz frame arrival. The
 // server accepts revisions only while the frame is still unfinalized; a racing
 // late revision becomes stale and the next scheduled frame carries the state.
 if(!active||botMode||!timeline||lastInputFrameSent<=0)return;
 const serverFrame=timeline.highestReceivedFrame;
 const target=serverFrame+inputDelayFrames+1;
 if(target<1||target>lastInputFrameSent)return;
 sendLocal(target,localInputForFrame(target),true);
}
function publishState(frame){
 // Full netCheckState recursively walks the Flash display tree and can stall the
 // browser main thread for tens of milliseconds. In lockstep, every client has
 // already received the same authoritative inputs, so the production heartbeat
 // only needs the cheap VM tick/timeline state. The server still compares this
 // value across peers once per second and will stop the match if they disagree.
 if(frame%35===0){
  const started=GunMayhemClock.realNow();
  const state=call('netTickState');
  const elapsed=GunMayhemClock.realNow()-started;
  metrics.checkStateMs+=elapsed;metrics.maxCheckStateMs=Math.max(metrics.maxCheckStateMs,elapsed);
  if(!state||(state.timeline===10&&state.ticks!==frame))throw new Error('The game timeline is inconsistent. Start a new match.');
  send('state',{frame,state});
 }else if(frame%7===0)send('ack',{frame});
}
function step(input,catchup){
 const started=GunMayhemClock.realNow();
 // Catch-up is not rollback: each authoritative frame is still simulated once.
 // The replay flag is used only to suppress presentation/audio side effects for
 // old queued frames after a tab stall.
 GunMayhemClock.setReplay(catchup);
 const inputStarted=GunMayhemClock.realNow();
 call('netInput',input.frame,input.masks);
 const inputElapsed=GunMayhemClock.realNow()-inputStarted;
 metrics.inputMs+=inputElapsed;metrics.maxInputMs=Math.max(metrics.maxInputMs,inputElapsed);
 const advanceStarted=GunMayhemClock.realNow();
 GunMayhemClock.advance({render:!catchup});
 const advanceElapsed=GunMayhemClock.realNow()-advanceStarted;
 metrics.advanceMs+=advanceElapsed;metrics.maxAdvanceMs=Math.max(metrics.maxAdvanceMs,advanceElapsed);
 if(catchup){
  metrics.catchupFrames++;metrics.skippedRenderFrames++;
  metrics.skippedAdvanceMs+=advanceElapsed;metrics.maxSkippedAdvanceMs=Math.max(metrics.maxSkippedAdvanceMs,advanceElapsed);
 }else{
  metrics.renderedFrames++;
  metrics.renderedAdvanceMs+=advanceElapsed;metrics.maxRenderedAdvanceMs=Math.max(metrics.maxRenderedAdvanceMs,advanceElapsed);
 }
 GunMayhemClock.setReplay(false);
 sequence=input.frame;
 consumeInputLatencyFrame(input,catchup);
 metrics.framesSimulated++;
 if(input.fallbackSlots.length){
  metrics.fallbackFrames++;metrics.fallbackInputs+=input.fallbackSlots.length;
  if(input.fallbackSlots.includes(timeline.localSlot))metrics.localFallbacks++;
  metrics.remoteFallbacks+=input.fallbackSlots.filter(slot=>slot!==timeline.localSlot).length;
 }
 publishState(sequence);
 const elapsed=GunMayhemClock.realNow()-started;
 metrics.tickMs+=elapsed;metrics.maxTickMs=Math.max(metrics.maxTickMs,elapsed);
 recordSpikeSample(elapsed,advanceElapsed,catchup);
 send('rendered',{frame:sequence,confirmed:sequence,metrics});
}
function cycle(){
 if(!active)return;
 try{
  let processed=0;
  while(timeline.hasNext&&processed<maxCatchupPerCycle){
   const buffered=timeline.bufferedFrames;
   metrics.maxBufferedFrames=Math.max(metrics.maxBufferedFrames,buffered);
   metrics.maxBehindMs=Math.max(metrics.maxBehindMs,Math.max(0,buffered-1)*frameBudgetMs);
   const catchup=buffered>2;
   step(timeline.advance(),catchup);
   processed++;
  }
  timer=nativeTimeout(cycle,timeline.hasNext?0:2);
 }catch(error){fail(error);}
}
function boot(){
 if(ready)return;
 try{GunMayhemClock.advance();timer=nativeTimeout(boot,2);}catch(error){fail(error);}
}
window.addEventListener('message',event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data.source!=='gunmayhem-app')return;
 const data=event.data;
 try{
  if(data.type==='start'){
   call('netStart',data.config);sequence=0;send('started');
  }else if(data.type==='begin'){
   match=data.match;
   inputDelayFrames=data.players<=3?1:3;
   graceMs=6;
   botMode=GunMayhemRollback.normalizeBotMode(data.botMode);botSlot=data.slot;
   timeline=new GunMayhemRollback.LockstepTimeline({match,players:data.players,localSlot:data.slot});
   lastInputFrameSent=0;lastFrameArrivalAt=0;
   spikeRecorder.ring.length=0;spikeRecorder.events.length=0;spikeRecorder.capture=null;spikeRecorder.report=null;spikeRecorder.cooldownUntil=0;resetInputLatency();
   {const a=RuffleRollbackAudio.diagnostics();spikeRecorder.lastAudio100=a?.lateGte100Ms??0;spikeRecorder.lastAudioDrop=a?.lateDropped??0;spikeRecorder.lastFallbackFrames=metrics.fallbackFrames;}
   seedLocalInputs();
   active=true;
   RuffleRollbackAudio.setAudible(true);
   cycle();
  }else if(data.type==='frame'){
   if(!timeline||data.packet.match!==match)return;
   const now=GunMayhemClock.realNow();
   if(lastFrameArrivalAt){
    const gap=now-lastFrameArrivalAt;
    metrics.frameArrivalGapMs+=gap;metrics.maxFrameArrivalGapMs=Math.max(metrics.maxFrameArrivalGapMs,gap);
   }
   lastFrameArrivalAt=now;
   const result=timeline.receiveFrame(data.packet);
   if(result.status==='accepted'){
    metrics.receivedFrames++;
    metrics.maxBufferedFrames=Math.max(metrics.maxBufferedFrames,timeline.bufferedFrames);
    scheduleLocalInput(data.packet.frame);
   }else if(result.status==='duplicate')metrics.duplicateFrames++;
   else if(result.status==='stale')metrics.staleFrames++;
  }else if(data.type==='latencyProbe'&&!botMode)queueInputLatencyProbe(data.probe);
  else if(data.type==='localInput'&&!botMode){const changed=data.mask!==localMask;localMask=data.mask;pruneInputLatencyProbes(localMask);if(changed)reviseLocalInputNow();}
  else if(data.type==='debugEvent')spikeEvent(data.event?.type||'event',data.event||{});
  else if(data.type==='result'){resultScreen=true;active=false;clearTimeout(timer);}
  else if(data.type==='volume')player.ruffle(1).volume=data.volume;
 }catch(error){fail(error);}
});
window.addEventListener('keydown',event=>{event.preventDefault();event.stopImmediatePropagation();send('key',{code:event.code,down:true});},true);
window.addEventListener('keyup',event=>{event.preventDefault();event.stopImmediatePropagation();send('key',{code:event.code,down:false});},true);
for(const type of ['pointerdown','pointerup','pointermove','pointerenter','pointerleave','mousedown','mouseup','mousemove','wheel'])window.addEventListener(type,event=>event.stopImmediatePropagation(),true);
window.addEventListener('click',event=>{
 if(resultScreen){
  const bounds=player.getBoundingClientRect(),scale=Math.min(bounds.width/900,bounds.height/600);
  const x=(event.clientX-bounds.left-(bounds.width-900*scale)/2)/scale,y=(event.clientY-bounds.top-(bounds.height-600*scale)/2)/scale;
  if(x>=635&&x<=890&&y>=530&&y<=590)send('return');
 }else send('focus');
});
window.addEventListener('blur',()=>send('release'));
window.addEventListener('error',event=>fail(new Error(event.message)));
window.rollbackDiagnostics=baseDiagnostics;
window.unlockGameAudio=()=>{try{RuffleRollbackAudio.unlock();}catch{}try{player?.ruffle(1).resume();}catch{}};
window.gunmayhemSpikeReport=()=>spikeRecorder.report;
window.gunmayhemSpikeDownload=()=>{
 const report=spikeRecorder.report;if(!report)return false;
 const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=`gunmayhem-spike-${report.trigger?.frame??'unknown'}-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;
};
(async()=>{
 try{
  // The scalar Ruffle fallback is used by Safari versions without every modern
  // WebAssembly extension. Lockstep does not capture memory, so the optional
  // SIMD checkpoint helper may be unavailable without affecting simulation.
  try{await RuffleRollback.pagesReady;}catch{}
  player=RufflePlayer.newest().createPlayer();document.querySelector('#player').append(player);
  const data=new Uint8Array(await(await fetch('./gunmayhem-net.swf')).arrayBuffer());
  await player.ruffle(1).load({data,swfFileName:'gunmayhem-net.swf',allowScriptAccess:true});boot();
 }catch(error){fail(error);}
})();

'use strict';
const $ = id => document.getElementById(id);
const keys = new Map([['KeyW',1],['ArrowUp',1],['KeyA',2],['ArrowLeft',2],['KeyS',4],['ArrowDown',4],['KeyD',8],['ArrowRight',8],['KeyJ',16],['BracketLeft',16],['KeyK',32],['BracketRight',32]]);
const held = new Set();
const touchHeld = new Set(), touchPointers = new Map();
const palette = ['#77b4f7','#ef7061','#f6ca64','#8bd096'];
const skinPalette=['#19c8e8','#1768eb','#8a58db','#ec69dc','#ff7474','#e71818','#fff176','#ffc20d','#b9ff18','#41cf69'];
const shirtNames=['Shirtless','White Suit','Gray Suit','Professional Killer','Fancy Tux','Leather Jacket','Pompous Shirt','Pirate','Kung Fu Master','Caveman','Santa Claus','Exterminator','Jumpsuit','Rambo','Hawaiian'];
const hatNames=['Too Cool for Hats','Mohawk','Santa Claus','White Fedora','Dark Gray Fedora','Fancy Top Hat','Caveman','Crazy Clown','Pylon Hat','Straw Hat','Pompous Hat','Viking Helmet','Rambo','Spikey Helmet','ARRRRRRGH!','Goldfish Bowl','Bunny Ears','Army Helmet','The Duke','Pot Head','Slick Hair','Female Hair','The Very Best','Crown'];
let savedProfile=null;
let socket, myId, room, match, iframe, bootConfig, reconnectTimer, pingTimer, reconnectAttempts = 0, volume = 1, started = false, latestFrame = 0, stateCache;
let pingSequence = 0, latencyMs = null, inputLatencyMs = null, inputLatencyP95Ms = null, inputLatencyCount = 0, inputProbeSequence = 0;
const pingSent = new Map(), latencySamples = [];
let showingResult = false, resultFrame = null, runtimeError = '';
const query = new URLSearchParams(location.search);
let joinAfterConnect = query.get('room');
const botMode = /^(?:1|2|3|4|stress)$/.test((query.get('bot')||'').toLowerCase()) ? (query.get('bot')||'').toLowerCase() : '';
let spikeButton=null;
function ensureSpikeButton(){
 if(spikeButton)return spikeButton;
 spikeButton=document.createElement('button');spikeButton.type='button';spikeButton.hidden=true;spikeButton.textContent='Spike captured · Download report';
 Object.assign(spikeButton.style,{position:'fixed',right:'14px',bottom:'14px',zIndex:'2147483647',padding:'9px 12px',border:'1px solid rgba(255,255,255,.35)',borderRadius:'8px',background:'rgba(20,20,24,.92)',color:'#fff',font:'600 13px system-ui,sans-serif',cursor:'pointer',boxShadow:'0 4px 18px rgba(0,0,0,.35)'});
 spikeButton.onclick=()=>window.gunmayhemSpikeDownload();document.body.append(spikeButton);return spikeButton;
}
function showSpikeButton(summary){const button=ensureSpikeButton();button.hidden=false;button.textContent=`Spike captured at frame ${summary?.frame??'?'} · Download report`;}
function hideSpikeButton(){if(spikeButton)spikeButton.hidden=true;}
function browserDebugEvent(type,extra={}){runtime('debugEvent',{event:{type,wallMs:Date.now(),visibility:document.visibilityState,...extra}});}
try { $('name').value = localStorage.getItem('gunmayhem-name') || 'Player'; } catch {}
try {const value=JSON.parse(localStorage.getItem('gunmayhem-profile-v1'));if(value&&Number.isInteger(value.color)&&value.color>=1&&value.color<=10&&Number.isInteger(value.shirt)&&value.shirt>=1&&value.shirt<=15&&Number.isInteger(value.hat)&&value.hat>=1&&value.hat<=24)savedProfile={color:value.color,shirt:value.shirt,hat:value.hat};} catch {}
const mapNames=['No Name','Dessert Duel','Underwater Slaughter','Solar Shootout','Great Wall Brawl','Magic Mushroom Mountain Melee','Desert Destruction','Hovering Houses','Midnight Wood','Polar Pwnage','Grim City','Safari Showdown'];
const modeNames={'last-man-standing':'LAST MAN STANDING','gun-game':'GUN GAME'};
for (let i=1;i<=12;i++) $('map').add(new Option(`${i}. ${mapNames[i-1]}`,i));
for (let i=1;i<=20;i++) $('lives').add(new Option(`${i}`,i));
$('skin-shirt').replaceChildren(...shirtNames.map((name,index)=>new Option(`${index+1}. ${name}`,index+1)));
$('skin-hat').replaceChildren(...hatNames.map((name,index)=>new Option(`${index+1}. ${name}`,index+1)));
$('skin-colors').replaceChildren(...skinPalette.map((color,index)=>{const button=document.createElement('button');button.type='button';button.className='skin-color';button.dataset.color=String(index+1);button.style.setProperty('--skin-color',color);button.setAttribute('role','radio');button.setAttribute('aria-label',`Color ${index+1}`);button.title=`Color ${index+1}`;return button;}));
$('lives').value = '10';
if (joinAfterConnect) $('room-code').value = joinAfterConnect;
function notice(message='') { $('notice').textContent = message; }
function send(type, data={}) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type,...data})); }
function latencyQuality(){
  if((inputLatencyP95Ms??0)>=150||(latencyMs??0)>=150)return 'high';
  if((inputLatencyP95Ms??0)>=110||(latencyMs??0)>=80)return 'moderate';
  return latencyMs===null?'':'good';
}
function refreshLatency(){
  const rtt=latencyMs===null?'RTT: measuring…':`RTT: ${latencyMs} ms`;
  let input='';
  if(started&&!botMode) input=inputLatencyMs===null?' · Input: press a control…':` · Input: ${inputLatencyMs} ms · P95: ${inputLatencyP95Ms} ms`;
  $('latency').textContent=rtt+input;$('latency').className=`latency${latencyQuality()?' '+latencyQuality():''}`;
  $('latency').title='RTT is WebSocket round-trip time. Input is software-measured keydown → next presented game frame; physical display scanout is not included.';
}
function resetInputLatency(){inputLatencyMs=null;inputLatencyP95Ms=null;inputLatencyCount=0;refreshLatency();}
function probeLatency() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const sequence=++pingSequence;
  pingSent.set(sequence,performance.now());
  while(pingSent.size>8)pingSent.delete(pingSent.keys().next().value);
  send('ping',{sequence});
}
function startLatency() {
  clearInterval(pingTimer);pingSent.clear();latencySamples.length=0;latencyMs=null;
  refreshLatency();probeLatency();pingTimer=setInterval(probeLatency,1000);
}
function stopLatency() {
  clearInterval(pingTimer);pingSent.clear();latencySamples.length=0;latencyMs=null;
  $('latency').textContent='RTT: unavailable';$('latency').className='latency';
}
function receiveLatency(data) {
  const sent=pingSent.get(data.sequence);if(sent===undefined)return;
  pingSent.delete(data.sequence);latencySamples.push(performance.now()-sent);
  if(latencySamples.length>5)latencySamples.shift();
  const ordered=[...latencySamples].sort((a,b)=>a-b);
  latencyMs=Math.round(ordered[Math.floor(ordered.length/2)]);
  refreshLatency();
}
function runtime(type,data={}) { iframe?.contentWindow?.postMessage({source:'gunmayhem-app',type,...data},location.origin); }
function unlockAudio() {try{iframe?.contentWindow?.unlockGameAudio?.();}catch{}}
function mask() { let bits=0; for (const key of held) bits |= keys.get(key)||0; for (const key of touchHeld) bits |= keys.get(key)||0; return bits; }
function refreshTouchButtons() { for (const button of document.querySelectorAll('.touch-button')) button.classList.toggle('active',touchHeld.has(button.dataset.code)); }
function release() { held.clear();touchHeld.clear();touchPointers.clear();refreshTouchButtons();send('input',{mask:0}); }
function setInput(code,down,source) {
  if (botMode || !keys.has(code) || !started) return;
  const before=mask(),bit=keys.get(code)||0;
  if (down) source.add(code); else source.delete(code);
  const after=mask();
  if(down&&!(before&bit)&&(after&bit)){
    runtime('latencyProbe',{probe:{id:++inputProbeSequence,startedAtMs:performance.timeOrigin+performance.now(),bit,code}});
  }
  send('input',{mask:mask()});
}
function key(code,down) {setInput(code,down,held);}
function setTouchControlsEnabled(enabled) {
  $('touch-controls').classList.toggle('enabled',enabled&&!botMode);
  $('touch-controls').setAttribute('aria-hidden',String(!enabled||Boolean(botMode)));
  if(!enabled)release();
}
function releaseTouchPointer(pointerId) {
  const code=touchPointers.get(pointerId);if(!code)return;
  touchPointers.delete(pointerId);
  if(![...touchPointers.values()].includes(code))setInput(code,false,touchHeld);
  refreshTouchButtons();
}
for(const button of document.querySelectorAll('.touch-button')){
  button.addEventListener('pointerdown',event=>{
    if(!started||botMode)return;
    event.preventDefault();unlockAudio();
    try{button.setPointerCapture(event.pointerId);}catch{}
    const code=button.dataset.code;touchPointers.set(event.pointerId,code);setInput(code,true,touchHeld);refreshTouchButtons();
  });
  for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,event=>{event.preventDefault();releaseTouchPointer(event.pointerId);});
  button.addEventListener('contextmenu',event=>event.preventDefault());
}
function setOverlay(message) { $('overlay').classList.toggle('hidden',!message); $('overlay-text').textContent = message || ''; }
function stopGame(reason) {
  started=false;setTouchControlsEnabled(false);if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});setExpanded(false);resetInputLatency();match=null;bootConfig=null;showingResult=false;resultFrame=null;$('back').hidden=true;
  iframe?.remove(); iframe=null;
  $('play-section').hidden=true;document.body.classList.remove('playing');
  notice(reason);
}
function updateRoom(data) {
  room=data; $('entrance').hidden=true; $('lobby').hidden=false;
  $('room-title').textContent=data.room;
  const mine=data.players.find(p=>p.id===myId), host=data.host===myId;
  $('seat-label').textContent=`You are Player ${(mine?.slot??0)+1}`;
  $('seat-label').style.color=palette[mine?.slot??0];
  $('players').replaceChildren(...Array.from({length:4},(_,i)=>{
    const p=data.players.find(p=>p.slot===i), li=document.createElement('li');
    li.style.setProperty('--seat',palette[i]);
    if (!p) {li.className='empty';li.textContent='Awaiting player';return li;}
    for (const [cls,text] of [['player-number',`PLAYER ${i+1}`],['player-name',p.name]]) {const span=document.createElement('span');span.className=cls;span.textContent=text;li.append(span);}
    const appearance=document.createElement('span');appearance.className='player-appearance';const swatch=document.createElement('i');swatch.style.setProperty('--skin-color',skinPalette[(p.profile?.color||1)-1]);swatch.setAttribute('aria-hidden','true');appearance.append(swatch,document.createTextNode(`${shirtNames[(p.profile?.shirt||1)-1]} · ${hatNames[(p.profile?.hat||1)-1]}`));li.append(appearance);
    const meta=document.createElement('span');meta.className='player-meta';meta.textContent=[p.id===myId?'You':'',p.id===data.host?'Host':''].filter(Boolean).join(' · ')||'Ready';li.append(meta);
    return li;
  }));
  $('mode').value=data.settings.mode; $('map').value=data.settings.map; $('lives').value=data.settings.lives;
  $('mode-title').textContent=modeNames[data.settings.mode]||'ONLINE MULTIPLAYER';
  $('lives-setting').hidden=data.settings.mode==='gun-game';
  document.querySelector('.touch-grenade').hidden=data.settings.mode==='gun-game';
  $('grenade-help').hidden=data.settings.mode==='gun-game';
  const active=data.phase!=='lobby';
  if(mine?.profile){$('skin-shirt').value=mine.profile.shirt;$('skin-hat').value=mine.profile.hat;for(const button of document.querySelectorAll('.skin-color')){const selected=Number(button.dataset.color)===mine.profile.color;button.classList.toggle('selected',selected);button.setAttribute('aria-checked',String(selected));}}
  document.body.classList.toggle('playing',active||showingResult);
  $('mode').disabled=$('map').disabled=$('lives').disabled=!host||active;
  $('skin-shirt').disabled=$('skin-hat').disabled=active;for(const button of document.querySelectorAll('.skin-color'))button.disabled=active;
  $('start').disabled=!host||data.players.length<2||active;
  $('start').textContent=active?'Match in Progress':showingResult?'Play Again':'Start Match';
  $('stop').hidden=!host||!active;
  $('lobby-hint').textContent=active?'':data.players.length<2?'Invite at least one additional player to begin.':host?'The match may begin when all participants are ready.':'Awaiting the host to start the match.';
  const params=new URLSearchParams({room:data.room});if(botMode)params.set('bot',botMode);history.replaceState(null,'',`?${params}`);
}
function connect() {
  clearTimeout(reconnectTimer);
  const url=new URL('./ws',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  socket=new WebSocket(url);
  socket.onopen=()=>{reconnectAttempts=0;$('connection').textContent='Connected';$('connection').className='connection online';$('create').disabled=false;startLatency();};
  socket.onclose=()=>{
    stopLatency();
    $('connection').textContent='Connection lost. Reconnecting…';$('connection').className='connection';$('create').disabled=true;
    stopGame('The connection was interrupted and the match has ended. You may rejoin the room after the connection is restored.');
    room=null;$('entrance').hidden=false;$('lobby').hidden=true;
    reconnectTimer=setTimeout(connect,Math.min(1000*2**reconnectAttempts++,10000));
  };
  socket.onerror=()=>notice('The server is temporarily unavailable. Reconnection is in progress.');
  socket.onmessage=event=>{
    let data;try {data=JSON.parse(event.data);}catch{return;}
    if(data.type==='pong') receiveLatency(data);
    else if(data.type==='hello') {myId=data.id;if(joinAfterConnect){send('join',{room:joinAfterConnect,name:$('name').value});joinAfterConnect=null;}}
    else if(data.type==='joined') {myId=data.id;notice('');if(savedProfile)send('profile',savedProfile);}
    else if(data.type==='room') updateRoom(data);
    else if(data.type==='left') {const reason=runtimeError;runtimeError='';stopGame(reason);room=null;$('lobby').hidden=true;$('entrance').hidden=false;history.replaceState(null,'',location.pathname);}
    else if(data.type==='error') notice(data.message);
    else if(data.type==='load') {
      hideSpikeButton();stopGame('');match=data.match;bootConfig={seed:data.seed,mode:data.settings.mode,map:data.settings.map,lives:data.settings.lives,players:data.players,profiles:data.profiles};
      $('play-section').hidden=false;document.body.classList.add('playing');setOverlay('Loading the original game…');$('match-status').textContent='Loading…';
      iframe=document.createElement('iframe');iframe.title='Original Gun Mayhem game';iframe.allow='autoplay; fullscreen';iframe.src='./runtime.html';$('game-mount').replaceChildren(iframe);
    }
    else if(data.type==='begin') {if(data.match!==match)return;started=true;setTouchControlsEnabled(true);latestFrame=0;resetInputLatency();setOverlay('');$('match-status').textContent=botMode?`Bot ${botMode} active · automatic movement/fire`:document.body.classList.contains('touch-capable')?'Touch controls are active. Landscape orientation is recommended.':'Select the game window to activate controls.';runtime('volume',{volume});}
    else if(data.type==='tick') {if(data.match!==match)return;latestFrame=data.frame;runtime('tick',{frame:data.frame,masks:data.masks});}
    else if(data.type==='paused') {release();setOverlay('Awaiting the other players’ connections…');$('match-status').textContent='Synchronization Paused';}
    else if(data.type==='resumed') {setOverlay('');$('match-status').textContent='Match in Progress';}
    else if(data.type==='stopped') {
      if(data.finished&&iframe){started=false;setTouchControlsEnabled(false);match=null;showingResult=true;runtime('result');$('back').hidden=false;$('match-status').textContent='Match Complete';setOverlay('');notice(data.reason);}
      else stopGame(data.reason||'The match has ended. A new match may now be started.');
    }
  };
}
function stateHash(state) {const text=typeof state==='string'?state:JSON.stringify(state);let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(16);}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==iframe?.contentWindow||event.data?.source!=='gunmayhem-runtime')return;
  const data=event.data;
  if(data.type==='ready') {runtime('start',{config:bootConfig});}
  else if(data.type==='started') {send('loaded',{match});setOverlay('Awaiting completion of game loading by all players…');}
  else if(data.type==='ack'||data.type==='state') {
    const ack={match,frame:data.frame};
    if(data.type==='state') {stateCache=data.state;ack.hash=stateHash(data.state);}
    send('ack',ack);
    if (data.type==='state' && data.state && data.state.timeline !== 10) {
      if(resultFrame===null)resultFrame=data.frame;
      if(data.frame>=resultFrame+35)send('finish',{match,frame:data.frame});
    }
  }
  else if(data.type==='inputLatency'){inputLatencyMs=Math.round(data.medianMs);inputLatencyP95Ms=Math.round(data.p95Ms);inputLatencyCount=data.count||0;refreshLatency();}
  else if(data.type==='key')key(data.code,data.down);
  else if(data.type==='focus'&&started) $('match-status').textContent=botMode?`Bot ${botMode} active · automatic movement/fire`:'Match in Progress';
  else if(data.type==='return'&&showingResult) {stopGame('');if(room)updateRoom(room);}
  else if(data.type==='release')release();
  else if(data.type==='spikeCaptured')showSpikeButton(data.summary);
  else if(data.type==='error') {runtimeError=`The game could not be started: ${data.message}`;setOverlay('The game could not be loaded or synchronized. Leave the room and try again.');notice(runtimeError);send('leave');}
});
for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{if(!keys.has(event.code)||/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)||!started)return;event.preventDefault();if(!event.repeat)key(event.code,type==='keydown');});
window.addEventListener('blur',()=>{browserDebugEvent('blur');release();});
window.addEventListener('focus',()=>browserDebugEvent('focus'));
document.addEventListener('visibilitychange',()=>{browserDebugEvent('visibilitychange',{hidden:document.hidden});if(document.hidden)release();});
document.addEventListener('fullscreenchange',()=>browserDebugEvent('fullscreenchange',{fullscreen:Boolean(document.fullscreenElement)}));
window.addEventListener('resize',()=>browserDebugEvent('resize',{width:innerWidth,height:innerHeight}));
window.addEventListener('online',()=>browserDebugEvent('online'));
window.addEventListener('offline',()=>browserDebugEvent('offline'));
function saveName(){try{localStorage.setItem('gunmayhem-name',$('name').value.trim()||'Player');}catch{}}
function saveProfile(){
 const profile={color:Number(document.querySelector('.skin-color.selected')?.dataset.color||1),shirt:Number($('skin-shirt').value),hat:Number($('skin-hat').value)};
 savedProfile=profile;try{localStorage.setItem('gunmayhem-profile-v1',JSON.stringify(profile));}catch{}send('profile',profile);
}
$('create').onclick=()=>{saveName();send('create',{name:$('name').value});};
$('room-form').onsubmit=event=>{event.preventDefault();saveName();send('join',{room:$('room-code').value.trim().toUpperCase(),name:$('name').value});};
$('leave').onclick=()=>{send('leave');stopGame('');room=null;$('lobby').hidden=true;$('entrance').hidden=false;history.replaceState(null,'',location.pathname);};
$('start').onclick=()=>{notice('');send('start');};
$('stop').onclick=()=>send('stop');
$('back').onclick=()=>{stopGame('');if(room)updateRoom(room);};
for(const id of ['mode','map','lives'])$(id).onchange=()=>send('settings',{mode:$('mode').value,map:Number($('map').value),lives:Number($('lives').value)});
for(const button of document.querySelectorAll('.skin-color'))button.onclick=()=>{for(const item of document.querySelectorAll('.skin-color'))item.classList.toggle('selected',item===button);saveProfile();};
for(const id of ['skin-shirt','skin-hat'])$(id).onchange=saveProfile;
$('invite').onclick=async()=>{if(!room)return;const url=new URL(location.href);url.search=`?room=${room.room}`;try{await navigator.clipboard.writeText(url.href);notice('The invitation link has been copied. Share it with the other participants.');}catch{const input=document.createElement('input');input.value=url.href;document.body.append(input);input.select();const copied=document.execCommand('copy');input.remove();notice(copied?'The invitation link has been copied.':`Invitation link: ${url.href}`);}};
$('sound').onclick=()=>{volume=volume?0:1;if(volume)unlockAudio();runtime('volume',{volume});$('sound').textContent=`Sound: ${volume?'Enabled':'Disabled'}`;};
const touchCapable=('ontouchstart' in window)||matchMedia('(pointer:coarse)').matches;
document.body.classList.toggle('touch-capable',touchCapable);
let expanded=false;
function setExpanded(value){expanded=value;$('game-shell').classList.toggle('mobile-expanded',value);document.body.classList.toggle('mobile-expanded',value);$('fullscreen').textContent=value?'Exit Fullscreen':'Fullscreen';}
$('touch-exit').onclick=async()=>{if(document.fullscreenElement)await document.exitFullscreen();else setExpanded(false);};
$('fullscreen').onclick=async()=>{
  if(document.fullscreenElement){await document.exitFullscreen();return;}
  if(expanded){setExpanded(false);return;}
  if($('game-shell').requestFullscreen){
    try{await $('game-shell').requestFullscreen();try{await screen.orientation?.lock?.('landscape');}catch{}return;}catch{}
  }
  setExpanded(true);
};
document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'Exit Fullscreen':'Fullscreen';if(!document.fullscreenElement)try{screen.orientation?.unlock?.();}catch{}});
// Read-only diagnostics used by the cross-browser synchronization checks.
window.gunmayhemDiagnostics=()=>({room:room?.room,match,started,frame:latestFrame,state:stateCache,inputMask:mask(),touchCapable,profiles:room?.players?.map(player=>player.profile),latencyMs,inputLatencyMs,inputLatencyP95Ms,inputLatencyCount,rollback:iframe?.contentWindow?.rollbackDiagnostics?.()??null});
window.gunmayhemSpikeReport=()=>iframe?.contentWindow?.gunmayhemSpikeReport?.()??null;
window.gunmayhemSpikeDownload=()=>{
 const report=window.gunmayhemSpikeReport();if(!report){notice('No performance spike has been captured yet.');return false;}
 const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=`gunmayhem-spike-${report.trigger?.frame??'unknown'}-${Date.now()}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;
};
connect();

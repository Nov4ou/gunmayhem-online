'use strict';
let movie=null, profile={color:1,shirt:1,hat:1}, bridgeReady=false, announced=false;
function normalize(value,low,high,fallback){const number=Number(value);return Number.isInteger(number)&&number>=low&&number<=high?number:fallback;}
function setProfile(value={}){
 profile={color:normalize(value.color,1,10,1),shirt:normalize(value.shirt,1,15,1),hat:normalize(value.hat,1,24,1)};
 if(bridgeReady)movie?.netPreviewUpdate?.(profile);
}
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.data?.source!=='gunmayhem-app'||event.data.type!=='previewProfile')return;setProfile(event.data.profile);});
window.netReady=()=>{bridgeReady=true;movie.netPreviewStart(profile);};
function announceReady(){if(announced)return;announced=true;parent.postMessage({source:'gunmayhem-preview',type:'ready'},location.origin);}
window.netPreviewReady=announceReady;
(async()=>{
 const ruffle=window.RufflePlayer.newest();movie=ruffle.createPlayer();document.getElementById('player').append(movie);
 const readyTimer=setInterval(()=>{try{if(movie.netPreviewDebug?.().player){clearInterval(readyTimer);announceReady();}}catch{}},100);
 await movie.ruffle().load({url:'./gunmayhem-net.swf',autoplay:'on',allowScriptAccess:true,backgroundColor:'#24282e',scale:'showAll',letterbox:'on'});
})().catch(error=>parent.postMessage({source:'gunmayhem-preview',type:'error',message:String(error)},location.origin));

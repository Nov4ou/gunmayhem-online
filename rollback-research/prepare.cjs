'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {patchCore,patchWasm,CORE_FILE,WASM_FILE}=require('./state/patch.cjs');
const FALLBACK_CORE_FILE='core.ruffle.f000070ea72f8ae4fe3a.js',FALLBACK_WASM_FILE='72a20ef1c0b8ceb37720.wasm';
const source=path.resolve(__dirname,'../public'),build=path.join(__dirname,'build'),output=path.join(build,'public'),vendor=path.join(build,'ruffle');
const project=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../package.json')));
fs.rmSync(output,{recursive:true,force:true});fs.rmSync(vendor,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});fs.mkdirSync(vendor,{recursive:true});
fs.copyFileSync(path.join(__dirname,'netcode/server.cjs'),path.join(__dirname,'build/server.js'));
fs.copyFileSync(path.join(__dirname,'netcode/rollback-inputs.js'),path.join(__dirname,'build/rollback-inputs.js'));
fs.writeFileSync(path.join(build,'package.json'),JSON.stringify({
 name:'gun-mayhem-lockstep-server',version:project.version,private:true,type:'commonjs',main:'server.js',dependencies:{ws:project.dependencies.ws}
},null,2)+'\n');
for(const file of ['index.html','style.css','gunmayhem-net.swf','preview.html','preview.js'])fs.copyFileSync(path.join(source,file),path.join(output,file));
fs.cpSync(path.join(source,'fonts'),path.join(output,'fonts'),{recursive:true});
for(const file of ['ruffle.js',CORE_FILE,WASM_FILE,FALLBACK_CORE_FILE,FALLBACK_WASM_FILE,'LICENSE_APACHE','LICENSE_MIT']){
 let data=fs.readFileSync(path.resolve(__dirname,'../node_modules/@ruffle-rs/ruffle',file));
 if(file===CORE_FILE)data=Buffer.from(patchCore(data.toString()));
 if(file===WASM_FILE)data=patchWasm(data);
 fs.writeFileSync(path.join(vendor,file),data);
}
for(const [from,to]of [['state/snapshot.js','snapshot.js'],['state/clock.js','ruffle-clock.js'],['state/check-state.js','check-state.js'],['pages-direct.js','pages-direct.js'],['pages-direct.wasm','pages-direct.wasm'],['effects/audio.js','audio.js'],['effects/webgl-compact.js','webgl-compact.js'],['netcode/rollback-inputs.js','rollback-inputs.js'],['runtime.js','runtime.js']])fs.copyFileSync(path.join(__dirname,from),path.join(output,to));
let html=fs.readFileSync(path.join(source,'runtime.html'),'utf8');
html=html.replace('<script src="./ruffle-clock.js"></script>','<script src="./snapshot.js"></script><script src="./ruffle-clock.js"></script><script src="./check-state.js"></script><script src="./pages-direct.js"></script><script src="./audio.js"></script><script src="./webgl-compact.js"></script><script src="./rollback-inputs.js"></script>');
html=html.replace(/(quality:'[^']+',)/,"$1preferredRenderer:'wgpu-webgl',");
fs.writeFileSync(path.join(output,'runtime.html'),html);
let app=fs.readFileSync(path.join(source,'app.js'),'utf8');
function replace(from,to){if(!app.includes(from))throw new Error('Original app patch anchor missing: '+from);app=app.replace(from,to);}
replace("send('input',{mask:0});","runtime('localInput',{mask:0});");
replace("send('input',{mask:mask()});","runtime('localInput',{mask:mask()});");
replace("runtime('volume',{volume});}","runtime('volume',{volume});runtime('begin',{match,slot:room.players.find(p=>p.id===myId).slot,players:room.players.length,botMode});}");
replace("else if(data.type==='tick') {if(data.match!==match)return;latestFrame=data.frame;runtime('tick',{frame:data.frame,masks:data.masks});}","else if(data.type==='frame') {if(data.match!==match)return;runtime('frame',{packet:data});}\n    else if(data.type==='input') { /* Immediate input echo is diagnostic only in lockstep mode. */ }");
replace("else if(data.type==='key')key(data.code,data.down);","else if(data.type==='input')send('input',data.packet);\n  else if(data.type==='rendered'){latestFrame=data.frame;}\n  else if(data.type==='key')key(data.code,data.down);");
fs.writeFileSync(path.join(output,'app.js'),app);
console.log('Prepared isolated rollback build:',output);

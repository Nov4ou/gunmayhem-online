'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const frames = Number(process.env.GM_FAST_FRAMES || 350);
const maps = (process.env.GM_FAST_MAPS || '1,6,12').split(',').map(Number);
const html = `<!doctype html><meta charset="utf-8">
<script src="/rollback-research/build/public/snapshot.js"></script>
<script src="/rollback-research/build/public/ruffle-clock.js"></script>
<script src="/rollback-research/build/public/check-state.js"></script>
<script>window.RufflePlayer={config:{autoplay:'on',unmuteOverlay:'hidden',splashScreen:false,contextMenu:'off',allowScriptAccess:true,openUrlMode:'deny',warnOnUnsupportedContent:false}};</script>
<script src="/node_modules/@ruffle-rs/ruffle/ruffle.js"></script>
<style>html,body,#game,ruffle-player{margin:0;width:100%;height:100%;display:block}</style><div id="game"></div>
<script>
window.bridgeReady=false;window.netReady=()=>{bridgeReady=true};
window.call=(name,...args)=>player.ruffle(1).callExternalInterface(name,...args);
window.loaded=(async()=>{
 window.player=RufflePlayer.newest().createPlayer();document.querySelector('#game').append(player);
 const data=new Uint8Array(await (await fetch('/rollback-research/build/public/gunmayhem-net.swf')).arrayBuffer());
 await player.ruffle(1).load({data,swfFileName:'gunmayhem-net.swf',allowScriptAccess:true});
 for(let i=0;i<100&&!bridgeReady;i++){GunMayhemClock.advance();await new Promise(r=>setTimeout(r,0));}
 if(!bridgeReady)throw new Error('The movie did not register its bridge');
 return true;
})();
window.measure=()=>{
 const t0=GunMayhemClock.realNow();const original=call('netState');const t1=GunMayhemClock.realNow();
 const raw=call('netCheckState');const t2=GunMayhemClock.realNow();const chunks=raw.chunks.length;
 const chars=raw.chunks.reduce((n,s)=>n+s.length,0);const fast=GunMayhemCheckState.finishState(raw);const t3=GunMayhemClock.realNow();
 const originalAfter=call('netState');
 return{original,fast,originalAfter,chunks,chars,originalMs:t1-t0,fastBridgeMs:t2-t1,fastHashMs:t3-t2};
};
window.run=inputs=>{for(const [frame,masks] of inputs){call('netInput',frame,masks);GunMayhemClock.advance();}return measure()};
</script>`;
function serve(req, res) {
  if (req.url === '/test') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
  const filename = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!filename.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(filename, (error, bytes) => {
    const mime = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.swf': 'application/x-shockwave-flash' };
    res.writeHead(error ? 404 : 200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' });
    res.end(error ? String(error) : bytes);
  });
}
function masks(frame) {
  return [0, 1, 2, 3].map(p => ((Math.floor((frame + p * 83) / 117) % 2 ? 2 : 8)
    | ((frame + p * 7) % 43 < 4 ? 1 : 0) | (frame % (7 + p) < 5 ? 16 : 0)
    | ((frame + p * 13) % 79 < 2 ? 32 : 0)));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
(async () => {
  const report = { frames, maps, modes: ['last-man-standing', 'gun-game'], samples: [], errors: [] };
  const server = http.createServer(serve);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.GM_BROWSER_BIN || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const map of maps) for (const mode of report.modes) {
      const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(String(error)));
      try {
        await page.goto('http://127.0.0.1:' + server.address().port + '/test');
        await page.evaluate(() => loaded);
        await page.evaluate(({map,mode}) => call('netStart', { map, mode, players: 4, lives: 99, seed: 15481,
          profiles: [{ name: '中文🚀Player' }, { name: 'Åé🙂' }, { name: '三号' }, { name: 'Four' }] }), {map,mode});
        for (let start = 1; start <= frames; start += 35) {
          const end = Math.min(start + 34, frames);
          const inputs = Array.from({ length: end - start + 1 }, (_, i) => [start + i, masks(start + i)]);
          const sample = await page.evaluate(inputs => run(inputs), inputs);
          assert.equal(sample.original.mode, mode === 'gun-game' ? 4 : 1, `Map ${map}: wrong native mode`);
          assert.deepEqual(canonical(sample.fast), canonical(sample.original), `Mode ${mode} map ${map} frame ${end}: fast checksum/result changed`);
          assert.deepEqual(canonical(sample.originalAfter), canonical(sample.original), `Mode ${mode} map ${map} frame ${end}: original netState was altered`);
          const { original, fast, originalAfter, ...timings } = sample;
          report.samples.push({ mode, map, frame: end, checksum: original.checksum, entities: original.entities, ...timings });
          if (end === frames) console.log('MATCH', JSON.stringify(report.samples.at(-1)));
        }
      } finally { await context.close(); }
    }
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    report.passed = true;
    const average = key => report.samples.reduce((sum, sample) => sum + sample[key], 0) / report.samples.length;
    report.average = { originalMs: average('originalMs'), fastBridgeMs: average('fastBridgeMs'), fastHashMs: average('fastHashMs') };
    report.average.speedup = report.average.originalMs / (report.average.fastBridgeMs + report.average.fastHashMs);
    console.log('PASS', JSON.stringify(report.average));
  } catch (error) { report.error = String(error); throw error; }
  finally {
    const out = path.join(root, 'rollback-research/results/fast-state');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

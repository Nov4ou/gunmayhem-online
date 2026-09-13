'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium,webkit}=require('playwright');

(async()=>{
  const engine=process.env.GM_BROWSER_ENGINE||'chromium',browserType=engine==='webkit'?webkit:chromium;
  const gameMode=process.env.GM_GAME_MODE||'last-man-standing';
  assert(['chromium','webkit'].includes(engine),'GM_BROWSER_ENGINE must be chromium or webkit');
  assert(['last-man-standing','gun-game'].includes(gameMode),'GM_GAME_MODE must be last-man-standing or gun-game');
  const launch={headless:true,executablePath:process.env.GM_BROWSER_BIN||undefined};if(engine==='chromium')launch.args=['--autoplay-policy=no-user-gesture-required'];
  const browser=await browserType.launch(launch),forceFallback=process.env.GM_RUFFLE_FALLBACK==='1';
  const out=path.join(__dirname,'results','mobile');fs.mkdirSync(out,{recursive:true});
  const pages=[];
  try{
    for(let i=0;i<2;i++){
      const context=await browser.newContext({viewport:{width:844,height:390},deviceScaleFactor:2,isMobile:true,hasTouch:true});
      const page=await context.newPage();pages.push(page);
      if(forceFallback)await page.addInitScript(()=>{WebAssembly.validate=()=>false;});
      await page.goto(process.env.GAME_URL||'http://127.0.0.1:3003/');
      await page.waitForFunction(()=>document.getElementById('connection').textContent==='Connected');
      assert.equal(await page.evaluate(()=>gunmayhemDiagnostics().touchCapable),true);
      assert.equal(await page.locator('#touch-controls').evaluate(element=>getComputedStyle(element).display),'none');
      await page.locator('#name').fill('Mobile Test '+(i+1));
    }
    await pages[0].locator('#create').click();await pages[0].locator('#room-title').waitFor();
    if(gameMode!=='last-man-standing')await pages[0].locator('#mode').selectOption(gameMode);
    await pages[0].waitForFunction(mode=>document.getElementById('mode').value===mode&&document.getElementById('mode-title').textContent===(mode==='gun-game'?'GUN GAME':'LAST MAN STANDING'),gameMode);
    assert.equal(await pages[0].locator('#mode-title').textContent(),gameMode==='gun-game'?'GUN GAME':'LAST MAN STANDING');
    assert.equal(await pages[0].locator('#lives-setting').isHidden(),gameMode==='gun-game');
    const room=await pages[0].locator('#room-title').textContent();
    await pages[1].locator('#room-code').fill(room);await pages[1].locator('button[type="submit"]').click();
    await pages[0].locator('.skin-color[data-color="10"]').click();await pages[0].locator('#skin-shirt').selectOption('15');await pages[0].locator('#skin-hat').selectOption('24');
    await pages[1].locator('.skin-color[data-color="1"]').click();await pages[1].locator('#skin-shirt').selectOption('2');await pages[1].locator('#skin-hat').selectOption('3');
    const expectedProfiles=[{color:10,shirt:15,hat:24},{color:1,shirt:2,hat:3}];
    await Promise.all(pages.map(page=>page.waitForFunction(expected=>JSON.stringify(gunmayhemDiagnostics().profiles)===JSON.stringify(expected),expectedProfiles)));
    await pages[0].screenshot({path:path.join(out,'lobby-appearance.png'),fullPage:true});
    await pages[0].waitForFunction(()=>!document.getElementById('start').disabled);await pages[0].locator('#start').click();
    await Promise.all(pages.map(page=>page.waitForFunction(()=>gunmayhemDiagnostics().started,{},{timeout:90000})));
    for(const page of pages){const frame=page.frames().find(candidate=>candidate.url().includes('runtime.html'));assert(frame);const native=await frame.evaluate(()=>call('netState'));assert.equal(native.mode,gameMode==='gun-game'?4:1);assert.deepEqual(native.profiles.slice(0,2).map(({color,shirt,hat})=>({color,shirt,hat})),expectedProfiles);}
    if(forceFallback)for(const page of pages){const frame=page.frames().find(candidate=>candidate.url().includes('runtime.html'));assert(frame);assert.equal(await frame.evaluate(()=>RuffleRollback.inspect().initialized),false);}
    assert.equal(await pages[0].locator('#touch-controls').evaluate(element=>getComputedStyle(element).display),'flex');
    const boxes=await pages[0].locator('.touch-button').evaluateAll(buttons=>buttons.filter(button=>getComputedStyle(button).display!=='none').map(button=>{const box=button.getBoundingClientRect();return{x:box.x,y:box.y,right:box.right,bottom:box.bottom,width:box.width,height:box.height};}));
    assert.equal(boxes.length,gameMode==='gun-game'?5:6);for(const box of boxes){assert(box.width>=40&&box.height>=40);assert(box.x>=0&&box.y>=0&&box.right<=844&&box.bottom<=390);}
    await pages[0].evaluate(()=>document.querySelector('.touch-left').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:11,pointerType:'touch'})));
    await pages[0].evaluate(()=>document.querySelector('.touch-fire').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:12,pointerType:'touch'})));
    assert.equal(await pages[0].evaluate(()=>gunmayhemDiagnostics().inputMask),18);
    await pages[0].evaluate(()=>document.querySelector('.touch-left').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:11,pointerType:'touch'})));
    assert.equal(await pages[0].evaluate(()=>gunmayhemDiagnostics().inputMask),16);
    await pages[0].evaluate(()=>document.querySelector('.touch-fire').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:12,pointerType:'touch'})));
    assert.equal(await pages[0].evaluate(()=>gunmayhemDiagnostics().inputMask),0);
    await pages[0].evaluate(()=>{document.getElementById('game-shell').requestFullscreen=undefined;});await pages[0].locator('#fullscreen').click();
    assert.equal(await pages[0].locator('#game-shell').evaluate(element=>element.classList.contains('mobile-expanded')),true);
    assert.equal(await pages[0].locator('#touch-controls').evaluate(element=>getComputedStyle(element).display),'flex');
    await pages[0].screenshot({path:path.join(out,'landscape.png')});
    await pages[0].locator('#touch-exit').click();assert.equal(await pages[0].locator('#game-shell').evaluate(element=>element.classList.contains('mobile-expanded')),false);await pages[0].locator('#stop').click();
    console.log(`PASS ${engine} ${gameMode} mobile landscape layout, multi-touch input, fullscreen fallback${forceFallback?' and scalar Ruffle runtime':''}`);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

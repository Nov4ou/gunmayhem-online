'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.GM_BROWSER_BIN||undefined,args:['--autoplay-policy=no-user-gesture-required']});
  const out=path.join(__dirname,'results','mobile');fs.mkdirSync(out,{recursive:true});
  const pages=[];
  try{
    for(let i=0;i<2;i++){
      const context=await browser.newContext({viewport:{width:844,height:390},deviceScaleFactor:2,isMobile:true,hasTouch:true});
      const page=await context.newPage();pages.push(page);
      await page.goto(process.env.GAME_URL||'http://127.0.0.1:3003/');
      await page.waitForFunction(()=>document.getElementById('connection').textContent==='Connected');
      assert.equal(await page.evaluate(()=>gunmayhemDiagnostics().touchCapable),true);
      assert.equal(await page.locator('#touch-controls').evaluate(element=>getComputedStyle(element).display),'none');
      await page.locator('#name').fill('Mobile Test '+(i+1));
    }
    await pages[0].locator('#create').click();await pages[0].locator('#room-title').waitFor();
    const room=await pages[0].locator('#room-title').textContent();
    await pages[1].locator('#room-code').fill(room);await pages[1].locator('button[type="submit"]').click();
    await pages[0].waitForFunction(()=>!document.getElementById('start').disabled);await pages[0].locator('#start').click();
    await Promise.all(pages.map(page=>page.waitForFunction(()=>gunmayhemDiagnostics().started,{},{timeout:90000})));
    assert.equal(await pages[0].locator('#touch-controls').evaluate(element=>getComputedStyle(element).display),'flex');
    const boxes=await pages[0].locator('.touch-button').evaluateAll(buttons=>buttons.map(button=>{const box=button.getBoundingClientRect();return{x:box.x,y:box.y,right:box.right,bottom:box.bottom,width:box.width,height:box.height};}));
    assert.equal(boxes.length,6);for(const box of boxes){assert(box.width>=40&&box.height>=40);assert(box.x>=0&&box.y>=0&&box.right<=844&&box.bottom<=390);}
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
    console.log('PASS mobile landscape layout, multi-touch input and fullscreen fallback');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1400,height:900},deviceScaleFactor:1});
 const errors=[];page.on('console',message=>errors.push(`${message.type()}: ${message.text()}`));page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(process.env.GM_URL||'http://127.0.0.1:3003/',{waitUntil:'domcontentloaded'});
 await page.click('#create');
 try{await page.locator('.character-preview.ready').waitFor({timeout:30000});}catch(error){
  await page.screenshot({path:'/tmp/gunmayhem-preview-failure.png',fullPage:true});
  const frame=page.frames().find(item=>item.url().includes('preview.html'));
  const debug=frame?await frame.evaluate(()=>{const movie=document.querySelector('ruffle-player');return {ready:typeof window.netReady,previewReady:typeof window.netPreviewReady,movie:Boolean(movie),bridge:typeof movie?.netPreviewDebug,swf:movie?.netPreviewDebug?.(),text:document.body.innerText};}):null;
  console.error(JSON.stringify({error:String(error),errors,debug},null,2));throw error;
 }
 const before=await page.locator('#character-preview').screenshot();
 await page.selectOption('#skin-shirt','6');await page.selectOption('#skin-hat','8');await page.click('.skin-color[data-color="6"]');
 await page.waitForTimeout(1000);
 const after=await page.locator('#character-preview').screenshot();assert.notDeepEqual(before,after,'Character preview did not change');
 await page.screenshot({path:'/tmp/gunmayhem-preview.png',fullPage:true});
 const frame=page.frames().find(item=>item.url().includes('preview.html'));const swf=await frame.evaluate(()=>document.querySelector('ruffle-player').netPreviewDebug());
 assert.equal(swf.colorFrame,7);assert.equal(swf.shirtFrame,6);assert.equal(swf.hatFrame,8);
 await page.click('#leave');await page.waitForFunction(()=>!document.getElementById('character-preview-frame'));
 console.log(JSON.stringify({ready:true,swf,errors}));
 await browser.close();
})().catch(error=>{console.error(error);process.exitCode=1;});

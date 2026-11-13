import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const clips=JSON.parse(readFileSync('data/content.json','utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 for(const width of [1600,390]){
 const page=await browser.newPage({viewport:{width,height:900}});
 await page.goto('http://localhost:3210/host.html');await page.waitForSelector('.style-card');
 await page.evaluate(c=>{c.words=c.words.map(w=>w.gap?{...w,x:'____'}:w);socket.listeners('round:clip')[0](c);audio.pause();},clips[0]);
 await page.waitForTimeout(800);
 const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,lyrics:document.getElementById('lyrics').scrollHeight>document.getElementById('lyrics').clientHeight,first:document.getElementById('lyrics').scrollTop,answers:document.getElementById('answers').textContent}));
 if(result.overflow||result.first!==0||result.answers!=='0 réponse')throw Error(JSON.stringify(result));
 await page.screenshot({path:`e2e-shots/karaoke-${width}.png`,fullPage:true});await page.close();console.log('OK karaoke viewport '+width);
 }
}finally{await browser.close()}

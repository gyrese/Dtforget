import {chromium} from 'playwright-core';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
 await page.goto('http://localhost:3210/host.html'); await page.waitForSelector('.style-card');
 await page.screenshot({path:'e2e-shots/record-shop-desktop.png',fullPage:true});
 await page.evaluate(()=>{show('s-play');document.querySelector('#lyrics').innerHTML=Array.from({length:30},()=>'<div class="line">On connaît tous la chanson, à vous de trouver les paroles.</div>').join('');});
 const bounds=await page.locator('#s-play .bar').boundingBox();
 if(bounds.y+bounds.height>900)throw Error('Answer bar outside viewport: '+JSON.stringify(bounds));
 await page.screenshot({path:'e2e-shots/record-shop-lyrics.png'});
 await page.setViewportSize({width:375,height:812});
 await page.goto('http://localhost:3210/play.html');
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Phone overflow');
 await page.screenshot({path:'e2e-shots/record-shop-phone.png',fullPage:true});
 console.log('OK lyrics controls visible; phone 375px; final visual captures');
}finally{await browser.close();}

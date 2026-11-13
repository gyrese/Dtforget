import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const browser = await chromium.launch({channel:'chrome',headless:true});
const base = process.env.BASE || 'http://localhost:3210';
mkdirSync('e2e-shots',{recursive:true});
const errors=[];
try {
 for (const width of [1440,1024,768,390,320]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/host.html');
  await page.waitForSelector('.style-card');
  await page.waitForTimeout(1200);
  for (const view of ['menu','detail','library']) {
   if(view==='detail') await page.click('#explore-universe');
   if(view==='library') await page.click('#edit-list');
   await page.waitForTimeout(700);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
   if(overflow) throw Error('Overflow '+view+' '+width);
   await page.screenshot({path:`e2e-shots/${view}-${width}.png`,fullPage:true});
  }
  await page.close(); console.log('OK responsive '+width);
 }
 const page=await browser.newPage({reducedMotion:'reduce'});
 await page.goto(base+'/host.html');await page.waitForSelector('.style-card');
 await page.click('.style-card:has-text("Rock")');
 if(await page.textContent('#selected-title')!=='Rock')throw Error('Universe selection');
 await page.click('#explore-universe');
 if(!await page.isDisabled('#create-room'))throw Error('Empty list can launch');
 await page.click('.back-menu');await page.click('#manage');
 await page.click('#new-list');await page.fill('#list-name','Validation temporaire');
 await page.click('#select-visible');
 const count=await page.locator('#song-picker input:checked').count();
 if(!count)throw Error('Select all failed');
 await page.click('#clear-selection');
 if(await page.locator('#song-picker input:checked').count())throw Error('Clear failed');
 console.log('OK empty states, bulk selection, reduced motion');
 if(errors.length)throw Error(errors.join('\n'));
 console.log('OK no JavaScript errors');
}finally{await browser.close()}

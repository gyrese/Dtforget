// Capture d'une partie complète pour la vidéo promo : écran hôte filmé en 1920x1080,
// quatre téléphones filmés, et captures nettes (x2) à chaque étape.
// Prérequis : serveur lancé (npm start). Usage : node scripts/capture-promo.mjs
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.OUT || join(here, '..', '..', 'promo', 'captures');
const ROUNDS = Number(process.env.ROUNDS || 3);
const content = JSON.parse(readFileSync(join(here, '..', 'data', 'content.json'), 'utf8'));
const byAudio = new Map(content.map((c) => [c.audio, c]));
mkdirSync(join(OUT, 'video'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => {
  await page.screenshot({ path: join(OUT, name + '.png') });
  console.log('capture', name);
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

const contexts = [];
try {
  // --- Hôte (TV), filmé ---
  const hostCtx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: join(OUT, 'video'), size: { width: 1920, height: 1080 } },
  });
  contexts.push(['host', hostCtx]);
  const host = await hostCtx.newPage();
  await host.goto(BASE + '/host.html');
  await sleep(2500);
  await shot(host, '01-menu');
  await host.locator('button.style-card', { hasText: 'Disney' }).click();
  await sleep(1200);
  await shot(host, '02-univers');
  await host.click('#explore-universe');
  await host.locator('#create-room').waitFor({ state: 'visible' });
  await host.locator(`input[name="rounds"][value="${ROUNDS === 3 ? 3 : 5}"]`).check();
  await sleep(1200);
  await shot(host, '03-detail');
  await host.locator('#create-room').click();
  await host.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById('code').textContent), null, { timeout: 10000 });
  const code = (await host.textContent('#code')).trim();
  await sleep(1000);
  await shot(host, '04-salon-vide');

  // --- Quatre téléphones, filmés, captures nettes ---
  const names = ['Léa', 'Karim', 'Sophie', 'Max'];
  const players = [];
  for (const name of names) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      recordVideo: { dir: join(OUT, 'video'), size: { width: 780, height: 1688 } },
    });
    contexts.push(['phone-' + name, ctx]);
    const page = await ctx.newPage();
    await page.goto(BASE + '/play.html');
    if (name === names[0]) await shot(page, '05-tel-accueil');
    await page.locator('#code').pressSequentially(code, { delay: 120 });
    await page.locator('#name').pressSequentially(name, { delay: 120 });
    if (name === names[0]) await shot(page, '06-tel-code');
    await page.click('#join-btn');
    await page.locator('#v-wait').waitFor({ state: 'visible', timeout: 5000 });
    if (name === names[0]) await shot(page, '07-tel-attente');
    players.push({ name, page });
    await sleep(900);
  }
  await host.waitForFunction((n) => document.querySelectorAll('#players .player').length === n, names.length, { timeout: 5000 });
  await sleep(1500);
  await shot(host, '08-salon-4-joueurs');

  await host.click('#start');

  for (let round = 1; round <= ROUNDS; round++) {
    await host.locator('#s-intro.on').waitFor({ timeout: 30000 }).catch(() => {});
    await sleep(800);
    await shot(host, `10-m${round}-intro`);
    await host.locator('#s-play.on').waitFor({ timeout: 30000 });
    const src = await host.evaluate(() => new URL(document.getElementById('audio').src).pathname);
    const clip = byAudio.get(src);
    await sleep(2500);
    await shot(host, `11-m${round}-paroles`);

    for (const p of players) await p.page.locator('#v-answer').waitFor({ state: 'visible', timeout: 90000 });
    await shot(host, `12-m${round}-trou`);
    // Léa et Sophie (selon la manche) trouvent, les autres se trompent
    const answers = {
      Léa: round !== 2 ? clip?.answer : 'les étoiles',
      Karim: round === 2 ? clip?.answer : 'mot oublié',
      Sophie: clip?.answer,
      Max: 'la la la',
    };
    await Promise.all(players.map(async (p, i) => {
      await sleep(i * 400);
      await p.page.locator('#answer').pressSequentially(answers[p.name] || 'oups', { delay: 60 });
      if (p.name === 'Léa') await shot(p.page, `13-m${round}-tel-reponse`);
      await p.page.click('#answer-btn', { timeout: 8000 }).catch(() => {});
    }));
    await shot(host, `14-m${round}-reponses`);
    await shot(players[0].page, `15-m${round}-tel-envoye`);

    await host.locator('#s-reveal.on').waitFor({ timeout: 90000 });
    await sleep(1500);
    await shot(host, `16-m${round}-revelation`);
    await players[0].page.locator('#v-result').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    await shot(players[0].page, `17-m${round}-tel-resultat-lea`);
    await shot(players[3].page, `17-m${round}-tel-resultat-max`);
    await sleep(2500);
    if (await host.locator('#next').isVisible().catch(() => false)) await host.click('#next');
  }

  await host.locator('#s-over.on').waitFor({ timeout: 40000 });
  await sleep(3000);
  await shot(host, '20-podium');
  await players[0].page.locator('#v-over').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await shot(players[0].page, '21-tel-fin');
  await sleep(4000);
} catch (error) {
  console.log('ECHEC  ' + error.message);
  process.exitCode = 1;
} finally {
  for (const [label, ctx] of contexts) {
    const page = ctx.pages()[0];
    const video = page?.video();
    await ctx.close();
    if (video) {
      await video.saveAs(join(OUT, 'video', label + '.webm'));
      await video.delete();
    }
  }
  await browser.close();
}
console.log('Captures dans ' + OUT);

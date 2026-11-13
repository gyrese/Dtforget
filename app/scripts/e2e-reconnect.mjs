// Test de reconnexion joueur : un téléphone recharge sa page pendant l'intro, puis après sa réponse.
// Il doit retrouver sa place, son brouillon et son score, et recevoir la révélation.
// Prérequis : serveur lancé (npm start), Chrome installé. Usage : node scripts/e2e-reconnect.mjs
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://localhost:3000';
const content = JSON.parse(readFileSync(join(here, '..', 'data', 'content.json'), 'utf8'));
const byAudio = new Map(content.map((c) => [c.audio, c]));

let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? 'OK    ' : 'ECHEC ') + msg);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
  const hostCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const host = await hostCtx.newPage();
  await host.goto(BASE + '/host.html');
  await host.locator('button.style-card', { hasText: 'Disney' }).click();
  await host.click('#explore-universe');
  await host.locator('#create-room').click();
  await host.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById('code').textContent), null, { timeout: 10000 });
  const code = (await host.textContent('#code')).trim();

  const players = [];
  for (const name of ['Alice', 'Bruno']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/play.html');
    await page.fill('#code', code);
    await page.fill('#name', name);
    await page.click('#join-btn');
    await page.locator('#v-wait').waitFor({ state: 'visible', timeout: 5000 });
    players.push({ name, page, errors });
  }
  const [alice, bruno] = players;
  await host.waitForFunction(() => document.querySelectorAll('#players .player').length === 2, null, { timeout: 5000 });
  check(true, `salon ${code} : deux téléphones connectés`);

  await host.click('#start');
  await host.locator('#s-play.on').waitFor({ timeout: 30000 });
  const src = await host.evaluate(() => new URL(document.getElementById('audio').src).pathname);
  const clip = byAudio.get(src);
  if (!clip) throw new Error('extrait introuvable dans content.json');

  // 1) Alice recharge pendant l'intro : elle doit revenir en salle d'attente, sans doublon sur l'hôte
  await alice.page.waitForTimeout(300);
  await alice.page.reload();
  await alice.page.locator('#v-wait').waitFor({ state: 'visible', timeout: 5000 });
  const nameAfterReload = (await alice.page.textContent('#wait-name')).trim();
  check(nameAfterReload === 'Alice', `Alice recharge pendant l'intro : reprise en salle d'attente (${nameAfterReload})`);
  await host.waitForTimeout(500);
  const count = await host.$$eval('#players .player', (els) => els.length);
  check(count === 2, `pas de joueur en double sur l'hôte après rechargement (${count})`);

  // 2) la réponse ouverte : Alice répond, puis recharge avant la fin du temps
  await alice.page.locator('#v-answer').waitFor({ state: 'visible', timeout: 90000 });
  await alice.page.fill('#answer', clip.answer);
  await alice.page.click('#answer-btn');
  await alice.page.locator('#ans-status').waitFor({ state: 'visible', timeout: 5000 });
  await alice.page.reload();
  await alice.page.locator('#v-answer').waitFor({ state: 'visible', timeout: 5000 });
  const statusAfter = await alice.page.locator('#ans-status').isVisible();
  const btnDisabled = await alice.page.locator('#answer-btn').isDisabled();
  check(statusAfter && btnDisabled, 'Alice recharge après sa réponse : elle voit « réponse envoyée » et ne peut pas la renvoyer');

  // 3) Bruno répond faux ; l'hôte doit compter 2 réponses malgré le rechargement d'Alice
  await bruno.page.locator('#v-answer').waitFor({ state: 'visible', timeout: 90000 });
  await bruno.page.fill('#answer', 'mot inconnu');
  await bruno.page.click('#answer-btn');
  await host.waitForFunction(() => document.getElementById('answers').textContent.startsWith('2'), null, { timeout: 5000 });
  check(true, "l'hôte compte 2 réponses après le rechargement d'Alice");

  // 4) la révélation arrive bien sur le téléphone rechargé, avec les points d'Alice
  await alice.page.locator('#v-result').waitFor({ state: 'visible', timeout: 90000 });
  const pts = (await alice.page.textContent('#res-pts')).trim();
  check(/^\+\d+$/.test(pts) && Number(pts.slice(1)) > 0, `Alice reçoit la révélation avec ses points (${pts})`);

  check(alice.errors.length === 0 && bruno.errors.length === 0, `aucune erreur de page sur les téléphones (${alice.errors.length}, ${bruno.errors.length})`);
} catch (error) {
  failures++;
  console.log('ECHEC  arrêt : ' + error.message);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nTest de reconnexion : tout est OK' : `\nTest de reconnexion : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);

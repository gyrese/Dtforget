// Partie de test de bout en bout : un écran hôte (Chromium) et deux téléphones (Chromium mobile).
// Lance une partie Disney complète (5 manches) et vérifie l'essentiel à chaque étape.
// Prérequis : serveur lancé (npm start), Chrome installé. Usage : node scripts/e2e-game.mjs
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || join(here, '..', 'e2e-shots');
const content = JSON.parse(readFileSync(join(here, '..', 'data', 'content.json'), 'utf8'));
const byAudio = new Map(content.map((c) => [c.audio, c]));
mkdirSync(SHOTS, { recursive: true });

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
  // --- Hôte (écran TV) ---
  const hostCtx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const host = await hostCtx.newPage();
  const hostErrors = [];
  host.on('pageerror', (e) => hostErrors.push(e.message));
  host.on('console', (m) => { if (m.type() === 'error') hostErrors.push(m.text()); });

  await host.goto(BASE + '/host.html');
  await host.locator('button.style-card', { hasText: 'Disney' }).click();
  await host.click('#explore-universe');
  await host.locator('#create-room').waitFor({ state: 'visible' });
  await host.locator('#create-room').click();
  await host.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById('code').textContent), null, { timeout: 10000 });
  const code = (await host.textContent('#code')).trim();
  check(true, `salon créé, code ${code}`);
  await host.screenshot({ path: join(SHOTS, '01-lobby-hote.png') });

  // --- Deux téléphones ---
  const players = [];
  for (const name of ['Alice', 'Bruno']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BASE + '/play.html');
    await page.fill('#code', code);
    await page.fill('#name', name);
    await page.click('#join-btn');
    await page.locator('#v-wait').waitFor({ state: 'visible', timeout: 5000 });
    players.push({ name, page, errors });
  }
  check(true, 'deux téléphones connectés');
  await host.waitForFunction(() => document.querySelectorAll('#players .player').length === 2, null, { timeout: 5000 });
  await host.screenshot({ path: join(SHOTS, '02-lobby-2-joueurs.png') });

  await host.click('#start');

  // --- 5 manches ---
  for (let round = 1; round <= 5; round++) {
    await host.locator('#s-play.on').waitFor({ timeout: 30000 });
    const src = await host.evaluate(() => new URL(document.getElementById('audio').src).pathname);
    const clip = byAudio.get(src);
    check(!!clip, `manche ${round} : extrait chargé (${clip ? clip.title : src})`);
    if (!clip) throw new Error('extrait introuvable dans content.json');

    // le trou doit être masqué dès le départ : aucune lettre affichée
    const holes = await host.$$eval('#lyrics .w.hole', (els) => els.map((e) => e.textContent.trim()));
    check(holes.length > 0 && holes.every((h) => !/\p{L}/u.test(h)), `manche ${round} : trou en tirets (${holes.join(' | ')})`);
    await host.screenshot({ path: join(SHOTS, `03-manche${round}-debut.png`) });

    // les réponses : Alice donne la bonne, Bruno une fausse
    for (const p of players) {
      await p.page.locator('#v-answer').waitFor({ state: 'visible', timeout: 90000 });
    }
    const hostAnswerCount = host.locator('#answers');
    await players[0].page.fill('#answer', clip.answer);
    await players[0].page.click('#answer-btn');
    await players[1].page.fill('#answer', 'mot inconnu');
    await players[1].page.click('#answer-btn');
    await host.waitForFunction(() => document.getElementById('answers').textContent.startsWith('2'), null, { timeout: 5000 });
    check(true, `manche ${round} : 2 réponses reçues par l'hôte`);

    // la voix doit reprendre après le trou : on attend 1 s après la fin du trou
    const holeEnd = Math.max(...clip.words.filter((w) => w.gap).map((w) => w.e));
    await host.waitForFunction((t) => document.getElementById('audio').currentTime >= t, holeEnd + 1, { timeout: 90000 });
    const after = await host.evaluate(() => ({
      paused: document.getElementById('audio').paused,
      time: document.getElementById('audio').currentTime,
      sung: document.querySelectorAll('#lyrics .w.sung').length,
      error: document.getElementById('audio').error ? document.getElementById('audio').error.code : null,
    }));
    check(!after.paused && after.error === null && after.sung > 0, `manche ${round} : paroles qui reprennent après le trou (t=${after.time.toFixed(1)} s, ${after.sung} mots chantés)`);
    await host.screenshot({ path: join(SHOTS, `04-manche${round}-apres-trou.png`) });

    // révélation
    await host.locator('#s-reveal.on').waitFor({ timeout: 60000 });
    const revealed = (await host.textContent('#rev-answer')).trim().toLowerCase();
    check(revealed === clip.answer.trim().toLowerCase(), `manche ${round} : mot révélé « ${revealed} »`);
    const rows = await host.$$eval('#rev-ranking .rank', (els) => els.length);
    check(rows === 2, `manche ${round} : classement avec ${rows} lignes`);
    await host.screenshot({ path: join(SHOTS, `05-manche${round}-revelation.png`) });

    if (round < 5) {
      await host.locator('#s-intro.on').waitFor({ timeout: 30000 });
    }
  }

  await host.locator('#s-over.on').waitFor({ timeout: 30000 });
  check(true, 'partie terminée, écran de classement final affiché');
  await host.screenshot({ path: join(SHOTS, '06-classement-final.png') });

  // erreurs de console / de page
  check(hostErrors.length === 0, `aucune erreur sur l'écran hôte (${hostErrors.length})`);
  for (const p of players) check(p.errors.length === 0, `aucune erreur sur le téléphone de ${p.name} (${p.errors.length})`);
  if (hostErrors.length) console.log('  erreurs hôte :', hostErrors);
  for (const p of players) if (p.errors.length) console.log(`  erreurs ${p.name} :`, p.errors);
} catch (error) {
  failures++;
  console.log('ECHEC  arrêt : ' + error.message);
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPartie de test : tout est OK' : `\nPartie de test : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);

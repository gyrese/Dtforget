// Essai de bout en bout de l'application (non packagée) : installation vierge, puis analyse d'une chanson.
//   [EXE=dist\win-unpacked\DtForget Atelier.exe] node test-app.mjs <dossier de données> <fichier audio> [titre] [artiste]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', 'app', 'package.json'));
const { _electron } = require('playwright-core');
const [dataDir, song, title = 'Test', artist = 'Test'] = process.argv.slice(2);
const shots = join(here, 'dist', 'test-shots');
mkdirSync(shots, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const app = await _electron.launch({ executablePath: process.env.EXE || require(join(here, 'node_modules', 'electron')), args: process.env.EXE ? [] : [here], env: { ...process.env, DTFORGET_APP_DATA: dataDir } });
const page = await app.firstWindow();
page.on('console', (m) => { if (m.type() === 'error') log('console:', m.text()); });
await page.waitForLoadState('domcontentloaded');
log('page', page.url().slice(0, 60));

if (page.url().startsWith('file:')) {
  await page.screenshot({ path: join(shots, '1-installation.png') });
  await page.click('#go');
  let last = '';
  const watch = setInterval(async () => {
    try { const t = (await page.textContent('#step')) + ' | ' + (await page.textContent('#detail')); if (t !== last) { last = t; log(t.slice(0, 150)); } } catch { /* page en cours de changement */ }
  }, 5000);
  try { await page.waitForURL(/127\.0\.0\.1/, { timeout: 60 * 60 * 1000 }); }
  catch (e) { log('ÉCHEC installation :', await page.textContent('#error').catch(() => e.message)); await page.screenshot({ path: join(shots, '1-echec.png') }); clearInterval(watch); await app.close(); process.exit(1); }
  clearInterval(watch);
  log('installation terminée');
}

await page.waitForSelector('#v-media:not([hidden])');
await page.screenshot({ path: join(shots, '2-atelier.png') });
if (song) {
  await page.setInputFiles('#file', song);
  await page.fill('#title', title);
  await page.fill('#artist', artist);
  await page.click('#analyze');
  let last = '';
  const watch = setInterval(async () => {
    try { const t = await page.textContent('#progress li.now'); if (t && t !== last) { last = t; log('étape :', t); } } catch { /* rien */ }
  }, 3000);
  await page.waitForSelector('#v-lyrics:not([hidden]), #v-find:not([hidden]), #v-media:not([hidden])', { timeout: 60 * 60 * 1000 });
  clearInterval(watch);
  const lyrics = await page.isVisible('#v-lyrics'), find = await page.isVisible('#v-find');
  log(lyrics ? 'paroles prêtes : ' + (await page.locator('#lyrics .w').count()) + ' mots' : find ? 'paroles introuvables (recherche LRCLIB affichée)' : 'ÉCHEC : ' + (await page.textContent('#media-status')));
  if (lyrics) {
    const words = page.locator('#lyrics .w');
    await words.nth(40).click(); await words.nth(45).click();
    await page.click('#build');
    await page.waitForSelector('#v-done:not([hidden])', { timeout: 5 * 60 * 1000 });
    log('extrait :', await page.textContent('#done-lead'));
  }
}
await app.close();
log('fin');

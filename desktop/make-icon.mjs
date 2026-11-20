// Fabrique build/icon.ico (icône de l'exe) à partir du logo du jeu, app/public/assets/brand-mark.svg.
// Rendu par le Chromium de Playwright (déjà là pour les tests de l'app), une image PNG par taille dans le .ico.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, '..', 'app', 'package.json'))('playwright-core');
const svg = readFileSync(join(here, '..', 'app', 'public', 'assets', 'brand-mark.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// le Chromium de Playwright s'il est installé, sinon Edge (toujours présent sous Windows)
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'msedge' }));
const page = await browser.newPage();
const pngs = [];
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  pngs.push(await page.screenshot({ omitBackground: true }));
}
await browser.close();

// en-tête ICO, puis une entrée de 16 octets par image, puis les PNG à la suite
const head = Buffer.alloc(6 + 16 * SIZES.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(SIZES.length, 4);
let offset = head.length;
SIZES.forEach((size, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(size % 256, e); head.writeUInt8(size % 256, e + 1); // 0 = 256
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
mkdirSync(join(here, 'build'), { recursive: true });
writeFileSync(join(here, 'build', 'icon.ico'), Buffer.concat([head, ...pngs]));
writeFileSync(join(here, 'build', 'icon.png'), pngs[pngs.length - 1]);
console.log('build/icon.ico :', SIZES.join(', '), 'px');

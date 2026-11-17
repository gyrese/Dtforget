// Pochettes par défaut des playlists, direction « Plateau de nuit » : un projecteur sur la scène, un titre, des cases à remplir.
// Lancer depuis app/ : node scripts/create-record-art.mjs. Les images personnalisées des playlists restent prioritaires.
import {writeFileSync} from 'node:fs';
const night='#0a0c14', chalk='#f5f1e8';
const themes=[
  ['magic','#ffb627','LES GRANDS','CLASSIQUES','01'],
  ['rock','#ff5a66','MONTEZ','LE SON','02'],
  ['mix','#46d9ec','LE GRAND','MÉLANGE','03'],
];
for (const [id, light, first, last, num] of themes) {
  let bulbs = '';
  for (let x = 40; x <= 600; x += 28) bulbs += `<circle cx="${x}" cy="28" r="4" fill="${light}" opacity="${x % 56 === 12 ? .9 : .45}"/>`;
  writeFileSync(`public/assets/record-${id}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><defs><radialGradient id="s" cx="50%" cy="0%" r="85%"><stop offset="0" stop-color="${light}" stop-opacity=".55"/><stop offset=".45" stop-color="${light}" stop-opacity=".12"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></radialGradient><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light}" stop-opacity=".22"/><stop offset="1" stop-color="${light}" stop-opacity="0"/></linearGradient></defs><rect width="640" height="400" fill="${night}"/><path d="M250 0h140l150 400H100z" fill="url(#s)"/>${bulbs}<rect x="0" y="300" width="640" height="100" fill="url(#f)" opacity=".5"/><line x1="0" y1="300" x2="640" y2="300" stroke="${light}" stroke-opacity=".35"/><text x="48" y="96" font-family="'JetBrains Mono',monospace" font-weight="700" font-size="14" letter-spacing="3" fill="${light}">DTFORGET · PLAYLIST ${num}</text><text x="44" y="188" font-family="'Big Shoulders Display',Impact,sans-serif" font-weight="900" font-size="84" fill="${chalk}">${first}</text><text x="44" y="268" font-family="'Big Shoulders Display',Impact,sans-serif" font-weight="900" font-size="84" fill="${light}">${last}</text><g fill="none" stroke="${light}" stroke-width="3"><rect x="44" y="322" width="120" height="40" rx="8"/><rect x="176" y="322" width="80" height="40" rx="8"/><rect x="268" y="322" width="150" height="40" rx="8"/></g><g fill="${light}">${[0,1,2,3].map(i=>`<rect x="${60+i*24}" y="346" width="14" height="4" rx="2"/>`).join('')}${[0,1].map(i=>`<rect x="${192+i*24}" y="346" width="14" height="4" rx="2"/>`).join('')}${[0,1,2,3,4].map(i=>`<rect x="${284+i*26}" y="346" width="14" height="4" rx="2"/>`).join('')}</g></svg>`);
}

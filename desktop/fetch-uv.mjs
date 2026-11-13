// Récupère uv.exe (gestionnaire Python d'Astral) pour l'embarquer dans l'application : vendor/uv.exe.
// L'application s'en sert au premier lancement pour installer Python et les outils d'IA.
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.13.7';
const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, 'vendor');
if (existsSync(join(vendor, 'uv.exe'))) { console.log('uv.exe déjà présent'); process.exit(0); }
mkdirSync(vendor, { recursive: true });
const url = `https://github.com/astral-sh/uv/releases/download/${VERSION}/uv-x86_64-pc-windows-msvc.zip`;
const res = await fetch(url);
if (!res.ok) throw new Error(`Téléchargement de uv impossible (${res.status})`);
const zip = join(vendor, 'uv.zip');
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
// tar.exe de Windows 10+ sait lire les zip
const r = spawnSync('tar', ['-xf', zip, '-C', vendor, 'uv.exe'], { stdio: 'inherit' });
rmSync(zip);
if (r.status !== 0 || !existsSync(join(vendor, 'uv.exe'))) throw new Error('Extraction de uv.exe impossible');
console.log('uv.exe', VERSION, 'prêt');

// Atelier DtForget, application de bureau : la page de l'atelier dans sa propre fenêtre, le traitement sur ce PC.
// Au premier lancement, l'application installe elle-même Python, PyTorch (CUDA) et ffmpeg dans son dossier de données.
import { app, BrowserWindow, Menu, ipcMain, dialog, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, accessSync, constants } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:net';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const resources = app.isPackaged ? process.resourcesPath : join(here, '..');
// le serveur de l'atelier : resources/server dans le .exe (resources/app est l'application elle-même)
const serverDir = app.isPackaged ? join(resources, 'server') : join(here, '..', 'app');
const uv = app.isPackaged ? join(resources, 'bin', 'uv.exe') : join(here, 'vendor', 'uv.exe');
const FFMPEG_ZIP = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

// Dossier de données : à côté du .exe portable (tout suit sur une clé ou un autre disque), sinon dans le profil.
function pickDataDir() {
  if (process.env.DTFORGET_APP_DATA) return process.env.DTFORGET_APP_DATA;
  const beside = process.env.PORTABLE_EXECUTABLE_DIR && join(process.env.PORTABLE_EXECUTABLE_DIR, 'DtForget-Atelier-data');
  if (beside) { try { mkdirSync(beside, { recursive: true }); accessSync(beside, constants.W_OK); return beside; } catch { /* dossier protégé */ } }
  return join(app.getPath('userData'), 'data');
}
const data = pickDataDir();
const runtime = join(data, 'runtime');
const python = join(runtime, '.venv', 'Scripts', 'python.exe');
const binDir = join(data, 'bin');
const settingsFile = join(data, 'settings.json');
const readyFile = join(runtime, '.ready');
mkdirSync(data, { recursive: true });
process.env.PATH = binDir + delimiter + process.env.PATH;

const settings = () => { try { return JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
// Code de liaison affiché par le serveur en ligne : « dtf1. » + base64url de {"u": adresse, "t": jeton}
function parseLink(code) {
  const m = /^dtf1\.([A-Za-z0-9_-]+)$/.exec(String(code || '').trim());
  if (!m) return null;
  try {
    const { u, t } = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return /^https?:\/\/[^\s]+$/.test(u) && typeof t === 'string' && t.length >= 8 ? { url: u.replace(/\/+$/, ''), token: t } : null;
  } catch { return null; }
}
function saveLink(code) {
  if (!String(code || '').trim()) { writeFileSync(settingsFile, JSON.stringify({}, null, 2)); return { ok: true }; }
  const link = parseLink(code);
  if (!link) return { ok: false, error: 'Code de liaison invalide. Copiez-le tel que le serveur l’affiche.' };
  writeFileSync(settingsFile, JSON.stringify(link, null, 2));
  return { ok: true };
}

const restart = () => { app.relaunch(process.env.PORTABLE_EXECUTABLE_FILE ? { execPath: process.env.PORTABLE_EXECUTABLE_FILE } : {}); app.exit(0); };
let win = null;
const progress = (text, detail = '') => { if (win && !win.isDestroyed()) win.webContents.send('progress', { text, detail }); };

function run(cmd, args, { env = {}, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, windowsHide: true });
    let tail = '';
    for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', (line) => { tail = (tail + '\n' + line).slice(-3000); onLine(line); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(tail) : reject(new Error(tail.trim().split('\n').slice(-3).join(' ') || `${cmd} a échoué (${code})`)));
  });
}
const works = (cmd, args) => { try { return spawnSync(cmd, args, { windowsHide: true, timeout: 60000 }).status === 0; } catch { return false; } };

// Installation des outils d'IA. Relancée telle quelle, elle reprend là où elle s'était arrêtée.
async function bootstrap() {
  mkdirSync(runtime, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  rmSync(readyFile, { force: true });
  for (const f of ['pyproject.toml', 'uv.lock']) copyFileSync(join(resources, 'spike', f), join(runtime, f));

  progress('Installation de Python et de PyTorch', 'Plusieurs Go à télécharger : comptez 5 à 20 minutes selon la connexion.');
  await run(uv, ['sync', '--frozen', '--no-dev', '--project', runtime], {
    env: { UV_PYTHON_INSTALL_DIR: join(data, 'python'), UV_CACHE_DIR: join(data, 'uv-cache'), UV_PYTHON_PREFERENCE: 'only-managed', UV_PROJECT_ENVIRONMENT: join(runtime, '.venv'), UV_NO_PROGRESS: '1' },
    onLine: (line) => progress('Installation de Python et de PyTorch', line.trim().slice(0, 120)),
  });

  if (!works('ffmpeg', ['-version']) || !works('ffprobe', ['-version'])) {
    progress('Installation de ffmpeg', 'Téléchargement…');
    const zip = join(data, 'ffmpeg.zip'), tmp = join(data, 'ffmpeg-tmp');
    const res = await fetch(FFMPEG_ZIP);
    if (!res.ok) throw new Error('Téléchargement de ffmpeg impossible.');
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    await run('tar', ['-xf', zip, '-C', tmp, '--strip-components=2', '*/bin/ffmpeg.exe', '*/bin/ffprobe.exe']);
    for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) copyFileSync(join(tmp, exe), join(binDir, exe));
    rmSync(tmp, { recursive: true, force: true });
    rmSync(zip, { force: true });
  }

  progress('Vérification de la carte graphique');
  const gpu = spawnSync(python, ['-c', 'import torch; print(torch.cuda.is_available())'], { windowsHide: true, encoding: 'utf8', timeout: 180000 });
  if (gpu.status !== 0) throw new Error('L’environnement Python ne démarre pas : ' + String(gpu.stderr || '').trim().split('\n').pop());
  if (!/True/.test(gpu.stdout)) throw new Error('Aucune carte graphique NVIDIA utilisable n’a été détectée. Mettez à jour le pilote NVIDIA, puis relancez l’installation.');
  writeFileSync(readyFile, new Date().toISOString());
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startAtelier() {
  const link = settings();
  const port = await freePort();
  Object.assign(process.env, {
    PORT: String(port), HOST: '127.0.0.1', APP_MODE: '1', ATELIER: 'local',
    DATA_DIR: join(data, 'library'), ATELIER_PYTHON: python,
    DTFORGET_MODELS: join(data, 'models'), HF_HOME: join(data, 'huggingface'),
    PUBLISH_URL: link.url || '', PUBLISH_TOKEN: link.token || '',
  });
  mkdirSync(process.env.DATA_DIR, { recursive: true });
  mkdirSync(process.env.DTFORGET_MODELS, { recursive: true });
  await import(pathToFileURL(join(serverDir, 'server.js')).href);
  await win.loadURL(`http://127.0.0.1:${port}/atelier.html`);
}

// L'environnement Python contient des chemins absolus : si le dossier a été déplacé, on le reconstruit.
const ready = () => existsSync(readyFile) && works(python, ['-c', 'print(1)']);

ipcMain.handle('state', () => ({ installed: ready(), link: Boolean(settings().url), server: settings().url || '', settingsOnly: settingsOnly }));
ipcMain.handle('save-link', (_e, code) => {
  const r = saveLink(code);
  if (r.ok) restart();
  return r;
});
ipcMain.handle('install', async (_e, code) => {
  if (code) { const r = saveLink(code); if (!r.ok) return r; }
  try { await bootstrap(); await startAtelier(); return { ok: true }; }
  catch (error) { return { ok: false, error: error.message }; }
});

let settingsOnly = false;
app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180, height: 860, minWidth: 720, minHeight: 560, backgroundColor: '#f4efdf', title: 'DtForget Atelier',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Réglages', submenu: [
      { label: 'Serveur en ligne…', click: () => { settingsOnly = true; win.loadFile(join(here, 'setup.html')); } },
      { label: 'Réinstaller les outils d’IA', click: () => { rmSync(readyFile, { force: true }); restart(); } },
      { type: 'separator' },
      { label: 'Ouvrir le dossier de données', click: () => shell.openPath(data) },
      { role: 'quit', label: 'Quitter' },
    ] },
    { label: 'Affichage', submenu: [{ role: 'reload', label: 'Recharger' }, { role: 'togglefullscreen', label: 'Plein écran' }, { role: 'toggleDevTools', label: 'Outils de développement' }] },
  ]));
  try {
    if (ready()) await startAtelier();
    else await win.loadFile(join(here, 'setup.html'));
  } catch (error) {
    dialog.showErrorBox('DtForget Atelier', String(error?.stack || error));
    app.exit(1);
  }
});
app.on('window-all-closed', () => app.quit());

// Agent du PC : se connecte au serveur en ligne et exécute pour lui les traitements de l'atelier
// (séparation de la voix, paroles, extrait) avec la carte graphique de ce PC.
//   node --env-file-if-exists=.env agent.js     (PUBLISH_URL et PUBLISH_TOKEN dans app/.env)
import { io } from 'socket.io-client';
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPyWorker } from './pyworker.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = (process.env.PUBLISH_URL || '').replace(/\/+$/, '');
const token = process.env.PUBLISH_TOKEN || '';
if (!server || !token) { console.error('Réglez PUBLISH_URL et PUBLISH_TOKEN dans app/.env.'); process.exit(1); }

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const root = join(process.env.DATA_DIR || join(here, 'data'), 'agent');
mkdirSync(root, { recursive: true });
const py = createPyWorker(join(here, '..', 'spike'));
const auth = { Authorization: 'Bearer ' + token };
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

async function download(id, dir) {
  const res = await fetch(`${server}/api/agent/${id}/source`, { headers: auth });
  if (!res.ok) throw new Error('Le PC n’a pas pu récupérer le fichier sur le serveur.');
  const ext = /^\.[a-z0-9]{1,5}$/.test(res.headers.get('x-source-ext') || '') ? res.headers.get('x-source-ext') : '.bin';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(join(dir, 'source' + ext)));
}
async function upload(id, dir, name) {
  const res = await fetch(`${server}/api/agent/${id}/${name}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: readFileSync(join(dir, name)), signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error('Le PC n’a pas pu renvoyer le résultat au serveur.');
}

async function handle(job, step) {
  if (!ID.test(String(job.id))) throw new Error('Identifiant invalide.');
  const dir = join(root, job.id);
  mkdirSync(dir, { recursive: true });
  if (job.cmd === 'analyze') {
    if (!readdirSync(dir).some((f) => f.startsWith('source.'))) { step('fetch'); await download(job.id, dir); }
    const done = await py.runJob(dir, job, step);
    // aperçu léger pour le bouton « Écouter » de l'atelier en ligne
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(dir, 'audio.wav'), '-c:a', 'libmp3lame', '-b:a', '128k', join(dir, 'preview.mp3')]);
    if (r.status !== 0) throw new Error('Conversion de l’aperçu impossible (ffmpeg).');
    step('return');
    for (const name of ['preview.mp3', 'info.json', ...(done.lyrics ? ['words.json'] : [])]) await upload(job.id, dir, name);
    return done;
  }
  // les pistes séparées restent sur ce PC : sans elles, il faut refaire l'analyse
  if (!existsSync(join(dir, 'vocals_bs_roformer.flac'))) throw new Error('Les pistes de cette chanson ne sont plus sur le PC. Renvoyez le fichier pour refaire l’analyse.');
  const done = await py.runJob(dir, job, step);
  for (const name of job.cmd === 'build' ? ['clip.mp3', 'clip.json'] : ['info.json', 'words.json']) await upload(job.id, dir, name);
  return done;
}

const socket = io(server + '/agent', { auth: { token }, transports: ['websocket', 'polling'] });
const seen = new Map(); // jobId -> 'running' ou le message final, pour répondre à un renvoi après une coupure réseau
let chain = Promise.resolve();
socket.on('connect', () => log('connecté à', server));
socket.on('disconnect', (reason) => log('déconnecté :', reason));
socket.on('connect_error', (error) => log('connexion impossible :', error.message));
socket.on('job', (job) => {
  if (!job || typeof job.jobId !== 'string') return;
  const known = seen.get(job.jobId);
  if (known) { if (known !== 'running') socket.emit(...known); return; }
  seen.set(job.jobId, 'running');
  chain = chain.then(async () => {
    log('début', job.cmd, job.id);
    let result;
    try { result = ['job:done', { jobId: job.jobId, done: await handle(job, (step) => socket.emit('job:step', { jobId: job.jobId, step })) }]; }
    catch (error) { log('échec', job.cmd, error.message); result = ['job:error', { jobId: job.jobId, error: error.message }]; }
    seen.set(job.jobId, result);
    socket.emit(...result);
    log('fin', job.cmd, job.id);
  });
});

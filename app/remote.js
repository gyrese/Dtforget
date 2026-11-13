// Atelier du serveur en ligne : les traitements lourds sont confiés au PC (agent.js), qui se connecte de lui-même.
// Le serveur garde le fichier envoyé par le navigateur ; l'agent vient le chercher, travaille avec sa carte graphique,
// puis dépose les résultats (paroles alignées, aperçu audio, extrait) dans le dossier du média.
import express from 'express';
import { createWriteStream, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { timingSafeEqual, randomUUID } from 'node:crypto';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULT_FILES = new Set(['info.json', 'words.json', 'preview.mp3', 'clip.json', 'clip.mp3']);
const MAX_RESULT = 60 * 1024 * 1024;

export function createRemoteRunner({ io, root, token }) {
  const same = (given) => { const a = Buffer.from(String(given || '')), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
  let agent = null;   // socket du PC connecté
  let current = null; // traitement en cours : { jobId, payload, resolve, reject, onStep }

  const dispatch = () => {
    if (!current) return;
    if (agent) { agent.emit('job', current.payload); current.onStep('pc'); }
    else current.onStep('waiting_pc');
  };

  const nsp = io.of('/agent');
  nsp.use((socket, next) => same(socket.handshake.auth?.token) ? next() : next(new Error('Jeton refusé.')));
  nsp.on('connection', (socket) => {
    if (agent && agent !== socket) agent.disconnect(true);
    agent = socket;
    console.log('[atelier] PC de traitement connecté');
    dispatch(); // un traitement attendait le PC, ou la connexion a sauté en cours de route
    socket.on('job:step', ({ jobId, step } = {}) => { if (current?.jobId === jobId && typeof step === 'string') current.onStep(step); });
    socket.on('job:done', ({ jobId, done } = {}) => { if (current?.jobId === jobId) { const c = current; current = null; c.resolve(done || {}); } });
    socket.on('job:error', ({ jobId, error } = {}) => { if (current?.jobId === jobId) { const c = current; current = null; c.reject(new Error(String(error || 'Le traitement a échoué sur le PC.').slice(0, 300))); } });
    socket.on('disconnect', () => {
      if (agent !== socket) return;
      agent = null;
      console.log('[atelier] PC de traitement déconnecté');
      if (current) current.onStep('waiting_pc');
    });
  });

  function run(id, _dir, job, onStep) {
    return new Promise((resolve, reject) => {
      const jobId = randomUUID();
      current = { jobId, payload: { jobId, id, ...job }, resolve, reject, onStep };
      dispatch();
    });
  }

  // Échanges de fichiers avec l'agent
  const router = express.Router();
  router.use((req, res, next) => same(String(req.headers.authorization || '').replace(/^Bearer /, '')) ? next() : res.status(401).json({ error: 'Jeton refusé.' }));
  router.param('id', (req, res, next, id) => ID.test(id) && existsSync(join(root, id, 'meta.json')) ? next() : res.status(404).json({ error: 'Média inconnu.' }));
  router.get('/:id/source', (req, res) => {
    const dir = join(root, req.params.id);
    const name = readdirSync(dir).find((f) => f.startsWith('source.'));
    if (!name) return res.status(404).json({ error: 'Fichier source absent.' });
    res.set('X-Source-Ext', extname(name)).sendFile(join(dir, name));
  });
  router.put('/:id/:name', (req, res) => {
    if (!RESULT_FILES.has(req.params.name)) return res.status(400).json({ error: 'Fichier refusé.' });
    const file = join(root, req.params.id, req.params.name);
    const out = createWriteStream(file + '.part');
    let size = 0, failed = false;
    const fail = (status, error) => { if (failed) return; failed = true; out.destroy(); rmSync(file + '.part', { force: true }); if (!res.headersSent) res.status(status).json({ error }); };
    req.on('data', (chunk) => { size += chunk.length; if (size > MAX_RESULT) { fail(413, 'Fichier trop volumineux.'); req.destroy(); } });
    req.on('aborted', () => fail(400, 'Envoi interrompu.'));
    out.on('error', () => fail(500, 'Écriture impossible.'));
    out.on('finish', () => { if (failed) return; renameSync(file + '.part', file); res.json({ ok: true }); });
    req.pipe(out);
  });

  return { run, router, connected: () => Boolean(agent) };
}

// Envoi des extraits du PC (atelier) vers le serveur en ligne (VPS), et réception côté VPS.
//   PC  : PUBLISH_URL + PUBLISH_TOKEN  -> POST /api/publish
//   VPS : IMPORT_TOKEN                 -> PUT  /api/import/:clipId/audio puis PUT /api/import/:clipId
import express from 'express';
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { songKey } from './library.js';

const CLIP_ID = /^[\w.-]{1,120}$/;
const MAX_AUDIO = 40 * 1024 * 1024;

export function createPublisher({ content, contentFile, library, clipsDir, legacyDir }) {
  const importToken = process.env.IMPORT_TOKEN || '';
  const target = (process.env.PUBLISH_URL || '').replace(/\/+$/, '');
  const publishToken = process.env.PUBLISH_TOKEN || '';
  mkdirSync(clipsDir, { recursive: true });
  const saveContent = () => { writeFileSync(contentFile + '.tmp', JSON.stringify(content, null, 2)); renameSync(contentFile + '.tmp', contentFile); };

  /* ---------- réception (VPS) ---------- */
  const importer = express.Router();
  importer.use((req, res, next) => {
    if (!importToken) return res.status(404).json({ error: 'Import désactivé sur ce serveur.' });
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    const want = Buffer.from(importToken);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: 'Jeton refusé.' });
    next();
  });
  importer.param('clipId', (req, res, next, id) => CLIP_ID.test(id) ? next() : res.status(400).json({ error: 'Identifiant invalide.' }));
  importer.put('/:clipId/audio', (req, res) => {
    const file = join(clipsDir, req.params.clipId + '.mp3');
    const out = createWriteStream(file + '.part');
    let size = 0, failed = false;
    const fail = (status, error) => { if (failed) return; failed = true; out.destroy(); rmSync(file + '.part', { force: true }); if (!res.headersSent) res.status(status).json({ error }); };
    req.on('data', (chunk) => { size += chunk.length; if (size > MAX_AUDIO) { fail(413, 'Extrait trop volumineux.'); req.destroy(); } });
    req.on('aborted', () => fail(400, 'Envoi interrompu.'));
    out.on('error', () => fail(500, 'Écriture impossible.'));
    out.on('finish', () => { if (failed) return; if (!size) return fail(400, 'Fichier vide.'); renameSync(file + '.part', file); res.json({ ok: true }); });
    req.pipe(out);
  });
  importer.put('/:clipId', express.json({ limit: '6mb' }), (req, res) => {
    const id = req.params.clipId, c = req.body?.clip;
    const ok = c && typeof c.film === 'string' && c.film.trim() && typeof c.title === 'string' && c.title.trim() && typeof c.answer === 'string' && c.answer
      && Number.isFinite(c.cutAt) && Array.isArray(c.words) && c.words.length > 0 && c.words.length <= 3000
      && c.words.every((w) => w && Number.isFinite(w.t) && Number.isFinite(w.e) && typeof w.x === 'string' && typeof w.gap === 'boolean');
    if (!ok) return res.status(400).json({ error: 'Extrait invalide.' });
    if (!existsSync(join(clipsDir, id + '.mp3'))) return res.status(409).json({ error: 'Audio manquant : envoyez-le d’abord.' });
    const clip = { id, film: c.film.trim().slice(0, 80), title: c.title.trim().slice(0, 80), audio: `/media/${id}.mp3?v=${Date.now()}`, cutAt: c.cutAt,
      words: c.words.map((w) => ({ t: w.t, e: w.e, x: w.x.slice(0, 80), gap: w.gap })), answer: c.answer.slice(0, 400) };
    const at = content.findIndex((x) => x.id === id);
    at >= 0 ? content.splice(at, 1, clip) : content.push(clip);
    saveContent();
    for (const list of Array.isArray(req.body.lists) ? req.body.lists.slice(0, 50) : []) {
      try { library.importList(list, songKey(clip)); } catch { /* liste ignorée */ }
    }
    res.json({ ok: true });
  });

  /* ---------- envoi (PC) ---------- */
  const sourceFile = (clip) => {
    const path = clip.audio.split('?')[0];
    if (path.startsWith('/media/')) return join(clipsDir, basename(path));
    if (path.startsWith('/clips/')) return join(legacyDir, basename(path));
    return null;
  };
  async function send(clip, lists) {
    if (!CLIP_ID.test(clip.id)) throw new Error('identifiant non pris en charge');
    const src = sourceFile(clip);
    if (!src || !existsSync(src)) throw new Error('fichier audio introuvable');
    let file = src, temp = null;
    if (extname(src).toLowerCase() !== '.mp3') { // les extraits du spike sont en WAV : trop lourds pour Internet
      temp = join(tmpdir(), `dtforget-${randomUUID()}.mp3`);
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:a', 'libmp3lame', '-b:a', '192k', temp]);
      if (r.status !== 0) throw new Error('conversion mp3 impossible (ffmpeg)');
      file = temp;
    }
    try {
      const auth = { Authorization: 'Bearer ' + publishToken };
      const base = `${target}/api/import/${encodeURIComponent(clip.id)}`;
      const check = async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'erreur ' + r.status); };
      await check(await fetch(base + '/audio', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: readFileSync(file), signal: AbortSignal.timeout(120000) }));
      const { audio, ...meta } = clip;
      await check(await fetch(base, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ clip: meta, lists }), signal: AbortSignal.timeout(60000) }));
    } finally { if (temp) rmSync(temp, { force: true }); }
  }

  const sender = express.Router();
  let sending = false;
  sender.post('/', async (req, res) => {
    if (!target || !publishToken) return res.status(400).json({ error: 'Serveur en ligne non configuré (PUBLISH_URL et PUBLISH_TOKEN dans app/.env).' });
    if (sending) return res.status(409).json({ error: 'Un envoi est déjà en cours.' });
    const ids = Array.isArray(req.body?.clipIds) ? new Set(req.body.clipIds) : null;
    const clips = content.filter((c) => !ids || ids.has(c.id));
    if (!clips.length) return res.status(400).json({ error: 'Aucun extrait à envoyer.' });
    sending = true;
    const { lists } = library.get();
    const failed = [];
    let sent = 0;
    try {
      for (const clip of clips) {
        try { await send(clip, lists.filter((l) => l.songIds.includes(songKey(clip))).map(({ songIds, ...l }) => l)); sent++; }
        catch (error) {
          failed.push({ title: clip.title, error: error.cause?.code === 'ECONNREFUSED' || error.name === 'TypeError' ? 'serveur injoignable' : error.message });
          if (failed.length >= 3 && !sent) break; // inutile d'insister si rien ne passe
        }
      }
    } finally { sending = false; }
    res.json({ sent, failed, total: clips.length, target });
  });

  return { importer, sender, enabled: Boolean(target && publishToken), target };
}

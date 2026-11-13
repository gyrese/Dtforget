// Atelier d'ajout de média : envoi du fichier, analyse (worker Python du spike), paroles, choix du trou, extrait.
import express from 'express';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { songKey } from './library.js';

const EXT = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac', '.mp4', '.webm', '.mkv', '.mov', '.avi']);
const MAX_BYTES = 800 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UA = 'DtForget/0.1 (jeu prive)';

export function createWorkshop({ dataDir, content, contentFile, library, runner }) {
  const root = join(dataDir, 'workshop');
  const clipsDir = join(dataDir, 'clips');
  mkdirSync(root, { recursive: true });
  mkdirSync(clipsDir, { recursive: true });
  const jobs = new Map(); // id -> { step } pendant qu'un traitement tourne
  let busy = false;       // un seul traitement à la fois (une seule carte graphique)

  const dirOf = (id) => join(root, id);
  const writeJson = (file, data) => { writeFileSync(file + '.tmp', JSON.stringify(data, null, 2)); renameSync(file + '.tmp', file); };
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const meta = (id) => readJson(join(dirOf(id), 'meta.json'));
  const saveMeta = (id, patch) => { const next = { ...meta(id), ...patch }; writeJson(join(dirOf(id), 'meta.json'), next); return next; };

  // job : { cmd: 'analyze' | 'align' | 'build', … } ; le runner l'exécute sur place (Python) ou le confie au PC (agent)
  function run(id, job, after) {
    busy = true;
    jobs.set(id, { step: 'start' });
    saveMeta(id, { status: 'working', error: null });
    runner.run(id, dirOf(id), job, (step) => { const j = jobs.get(id); if (j) j.step = step; })
      .then((done) => saveMeta(id, after(done)))
      .catch((error) => { try { saveMeta(id, { status: 'error', error: error.message || 'Le traitement a échoué.' }); } catch (e) { console.error('[atelier]', e); } })
      .finally(() => { busy = false; jobs.delete(id); });
  }

  const afterLyrics = (id) => (done) => {
    const info = readJson(join(dirOf(id), 'info.json'));
    return { status: done.lyrics ? 'ready' : 'needs_lyrics', duration: info.duration, lyrics: info.lyrics };
  };

  // Reprise après un arrêt du serveur en plein traitement : l'analyse repart toute seule (le fichier est déjà là),
  // un alignement ou un extrait interrompu revient simplement à l'étape précédente.
  for (const id of readdirSync(root)) {
    if (!ID.test(id) || !existsSync(join(dirOf(id), 'meta.json')) || meta(id).status !== 'working') continue;
    const m = meta(id);
    if (existsSync(join(dirOf(id), 'info.json'))) saveMeta(id, { status: existsSync(join(dirOf(id), 'words.json')) ? 'ready' : 'needs_lyrics' });
    else if (!busy) run(id, { cmd: 'analyze', title: m.title, artist: m.artist }, afterLyrics(id));
    else saveMeta(id, { status: 'error', error: 'Traitement interrompu.' });
  }

  const router = express.Router();
  router.param('id', (req, res, next, id) => {
    if (!ID.test(id) || !existsSync(join(dirOf(id), 'meta.json'))) return res.status(404).json({ error: 'Ce média n’existe plus.' });
    next();
  });
  const guardBusy = (_req, res, next) => busy ? res.status(409).json({ error: 'Un autre traitement est en cours. Patientez quelques instants.' }) : next();

  // Recherche LRCLIB (sans les textes) pour choisir la bonne fiche à la main
  router.get('/lrclib', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (!q) return res.json([]);
    try {
      const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(String(r.status));
      res.json((await r.json()).filter((h) => !h.instrumental && (h.syncedLyrics || h.plainLyrics)).slice(0, 20)
        .map((h) => ({ id: h.id, track: h.trackName, artist: h.artistName, album: h.albumName, duration: h.duration, synced: Boolean(h.syncedLyrics) })));
    } catch { res.status(502).json({ error: 'LRCLIB ne répond pas. Réessayez dans un instant.' }); }
  });

  // Envoi du fichier (corps brut) puis analyse
  router.post('/upload', guardBusy, (req, res) => {
    const ext = extname(String(req.query.name || '')).toLowerCase();
    if (!EXT.has(ext)) return res.status(400).json({ error: 'Format non pris en charge. Envoyez un fichier audio ou vidéo (mp3, m4a, wav, mp4, webm, mkv…).' });
    const title = String(req.query.title || '').trim().slice(0, 80), artist = String(req.query.artist || '').trim().slice(0, 80);
    if (!title) return res.status(400).json({ error: 'Indiquez le titre de la chanson.' });
    const id = randomUUID();
    mkdirSync(dirOf(id));
    const out = createWriteStream(join(dirOf(id), 'source' + ext));
    let size = 0, failed = false;
    const fail = (status, error) => { if (failed) return; failed = true; out.destroy(); rmSync(dirOf(id), { recursive: true, force: true }); if (!res.headersSent) res.status(status).json({ error }); };
    req.on('data', (chunk) => { size += chunk.length; if (size > MAX_BYTES) { fail(413, 'Fichier trop volumineux (800 Mo au maximum).'); req.destroy(); } });
    req.on('aborted', () => fail(400, 'Envoi interrompu.'));
    req.pipe(out);
    out.on('error', () => fail(500, 'Impossible d’enregistrer le fichier.'));
    out.on('finish', () => {
      if (failed) return;
      if (!size) return fail(400, 'Fichier vide.');
      if (busy) return fail(409, 'Un autre traitement est en cours. Patientez quelques instants.');
      writeJson(join(dirOf(id), 'meta.json'), { id, file: String(req.query.name).slice(0, 200), title, artist, status: 'working', clips: [] });
      run(id, { cmd: 'analyze', title, artist }, afterLyrics(id));
      res.json({ id });
    });
  });

  router.get('/:id', (req, res) => {
    const m = meta(req.params.id);
    const state = { id: m.id, title: m.title, artist: m.artist, status: m.status, error: m.error || null, step: jobs.get(m.id)?.step || null, duration: m.duration, lyrics: m.lyrics || null, clips: m.clips || [] };
    const wordsFile = join(dirOf(m.id), 'words.json');
    if (m.status === 'ready' && existsSync(wordsFile)) state.words = readJson(wordsFile).map((w) => ({ x: w.text, t: w.start, e: w.end, l: w.line, u: w.uncertain }));
    res.json(state);
  });

  router.get('/:id/audio', (req, res) => {
    // sur le serveur en ligne, seul l'aperçu MP3 renvoyé par le PC est disponible
    const file = ['preview.mp3', 'audio.wav'].map((name) => join(dirOf(req.params.id), name)).find(existsSync);
    file ? res.sendFile(file) : res.status(404).end();
  });

  // Autres paroles : fiche LRCLIB choisie à la main, ou texte collé
  router.post('/:id/lyrics', guardBusy, (req, res) => {
    const id = req.params.id;
    if (!existsSync(join(dirOf(id), 'info.json'))) return res.status(409).json({ error: 'L’analyse de ce média n’a pas abouti. Renvoyez le fichier.' });
    const job = { cmd: 'align' };
    if (Number.isInteger(req.body?.lrclibId)) job.lrclibId = req.body.lrclibId;
    else if (typeof req.body?.text === 'string' && req.body.text.trim().length >= 20 && req.body.text.length < 20000) job.text = req.body.text;
    else return res.status(400).json({ error: 'Choisissez un résultat ou collez les paroles.' });
    run(id, job, afterLyrics(id));
    res.json({ ok: true });
  });

  // Fabrication de l'extrait et ajout à la bibliothèque
  router.post('/:id/clip', guardBusy, (req, res) => {
    const id = req.params.id, m = meta(id);
    const { first, last, listId } = req.body || {};
    const title = String(req.body?.title || '').trim().slice(0, 80), film = String(req.body?.film || '').trim().slice(0, 80);
    if (m.status !== 'ready') return res.status(409).json({ error: 'Les paroles ne sont pas prêtes.' });
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last - first > 24) return res.status(400).json({ error: 'Choisissez un passage de 1 à 25 mots.' });
    if (!title || !film) return res.status(400).json({ error: 'Indiquez le titre et l’artiste (ou le film).' });
    if (listId && !library.get().lists.some((l) => l.id === listId)) return res.status(400).json({ error: 'Cette liste n’existe plus.' });
    run(id, { cmd: 'build', first, last }, () => {
      const built = readJson(join(dirOf(id), 'clip.json'));
      const clipId = `${id}__${first}-${last}`;
      copyFileSync(join(dirOf(id), 'clip.mp3'), join(clipsDir, clipId + '.mp3'));
      const clip = { id: clipId, film, title, audio: `/media/${clipId}.mp3?v=${Date.now()}`, cutAt: built.cutAt, words: built.words, answer: built.answer };
      const at = content.findIndex((c) => c.id === clipId);
      at >= 0 ? content.splice(at, 1, clip) : content.push(clip);
      writeJson(contentFile, content);
      if (listId) library.addSong(listId, songKey(clip));
      const summary = { id: clipId, audio: clip.audio, cutAt: clip.cutAt, words: last - first + 1, listId: listId || null };
      return { status: 'ready', title, artist: film, clips: [...(m.clips || []).filter((c) => c.id !== clipId), summary] };
    });
    res.json({ ok: true });
  });

  return { router, root };
}

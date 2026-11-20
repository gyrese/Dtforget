// Bibliothèque de l'atelier : les extraits de ce serveur (titre, artiste, listes, fond), leur suppression,
// et les chansons commencées dans l'atelier qui n'ont pas encore d'extrait.
import express from 'express';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_EXT, BACKGROUND_FILE, receiveBackground, youtubeId } from './background.js';
import { songKey } from './library.js';
import { bedEnd } from './timing.js';

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mediaOf = (clipId) => clipId.split('__')[0];

export function createCatalog({ content, contentFile, library, clipsDir, workshopRoot }) {
  const writeJson = (file, data) => { writeFileSync(file + '.tmp', JSON.stringify(data, null, 2)); renameSync(file + '.tmp', file); };
  const saveContent = () => writeJson(contentFile, content);
  const metaFile = (mediaId) => join(workshopRoot, mediaId, 'meta.json');
  const readMeta = (mediaId) => { try { return MEDIA_ID.test(mediaId) ? JSON.parse(readFileSync(metaFile(mediaId), 'utf8')) : null; } catch { return null; } };

  // un fichier de fond n'est effacé que si plus aucun extrait ne s'en sert
  const dropBackground = (b) => {
    if (!b?.file || (!BACKGROUND_FILE.test(b.file) && !/^[\w-]+\.mp4$/.test(b.file))) return;
    if (content.some((c) => c.background?.file === b.file)) return;
    rmSync(join(clipsDir, b.file), { force: true });
  };

  // retire un extrait de ce serveur (fichiers compris) ; utilisé aussi quand un nouveau passage remplace l'ancien
  function removeClip(id) {
    const at = content.findIndex((c) => c.id === id);
    if (at < 0) return false;
    const [clip] = content.splice(at, 1);
    saveContent();
    rmSync(join(clipsDir, id + '.mp3'), { force: true });
    dropBackground(clip.background);
    const key = songKey(clip);
    if (!content.some((c) => songKey(c) === key)) library.setSongLists(key, []);
    const m = readMeta(mediaOf(id));
    if (m) writeJson(metaFile(m.id), { ...m, clips: (m.clips || []).filter((c) => c.id !== id) });
    return true;
  }

  const summary = (c) => ({
    id: c.id, title: c.title, film: c.film, answer: c.answer, audio: c.audio, cutAt: c.cutAt,
    background: c.background || null, updatedAt: c.updatedAt || null,
    sourceStart: c.sourceStart ?? null, sourceEnd: c.sourceEnd ?? null,
    words: (c.words || []).map((w) => ({ x: w.x, t: w.t, e: w.e, gap: w.gap, ...(w.br ? { br: true } : {}) })),
    // fin de la musique de jeu : le fichier continue ensuite avec la reprise chantée de la révélation
    bedEnd: bedEnd(c), revealAt: c.revealAt ?? null, lists: library.listsOf(songKey(c)),
    media: existsSync(metaFile(mediaOf(c.id))) ? mediaOf(c.id) : null,
  });

  const router = express.Router();
  router.param('clipId', (req, res, next, id) => content.some((c) => c.id === id) ? next() : res.status(404).json({ error: 'Cet extrait n’existe plus.' }));

  router.get('/library', (_req, res) => {
    const used = new Set(content.map((c) => mediaOf(c.id)));
    const drafts = existsSync(workshopRoot) ? readdirSync(workshopRoot).filter((id) => MEDIA_ID.test(id) && !used.has(id)).map(readMeta).filter(Boolean)
      .map((m) => ({ id: m.id, title: m.title, artist: m.artist, status: m.status, error: m.error || null })) : [];
    res.json({ clips: content.map(summary), drafts, lists: library.get().lists.map(({ id, name }) => ({ id, name })) });
  });

  // titre, artiste et listes ; known = listes du serveur en ligne à créer ici si on les coche
  router.patch('/library/:clipId', (req, res) => {
    const clip = content.find((c) => c.id === req.params.clipId);
    const title = String(req.body?.title ?? clip.title).trim().slice(0, 80), film = String(req.body?.film ?? clip.film).trim().slice(0, 80);
    if (!title || !film) return res.status(400).json({ error: 'Indiquez le titre et l’artiste (ou le film).' });
    // paroles corrigées et découpées à la main : une liste de lignes, autant de mots qu'avant (le minutage reste)
    const lyrics = req.body?.lyrics;
    if (lyrics !== undefined) {
      const flat = Array.isArray(lyrics) && lyrics.every((l) => Array.isArray(l) && l.length) ? lyrics.flat() : null;
      if (!flat || flat.length !== clip.words.length || !flat.every((x) => typeof x === 'string' && x.trim() && x.length <= 80 && !/\s/.test(x.trim())))
        return res.status(400).json({ error: `Les paroles doivent garder ${clip.words.length} mots.` });
      const starts = new Set(); let n = 0;
      for (const l of lyrics) { starts.add(n); n += l.length; }
      clip.words.forEach((w, i) => { w.x = flat[i].trim(); if (starts.has(i)) w.br = true; else delete w.br; });
      clip.answer = clip.words.filter((w) => w.gap).map((w) => w.x).join(' ');
    }
    const oldKey = songKey(clip);
    Object.assign(clip, { title, film, updatedAt: Date.now() });
    const newKey = songKey(clip);
    library.renameSong(oldKey, newKey, content.some((c) => songKey(c) === oldKey));
    if (Array.isArray(req.body?.lists)) {
      try { library.setSongLists(newKey, req.body.lists.filter((id) => typeof id === 'string'), Array.isArray(req.body.known) ? req.body.known : []); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
    saveContent();
    // le média garde le même nom : un nouveau passage fabriqué plus tard ne reviendra pas à l'ancien titre
    const m = readMeta(mediaOf(clip.id));
    if (m) writeJson(metaFile(m.id), { ...m, title, artist: film });
    res.json(summary(clip));
  });

  // fond en jeu : image ou vidéo envoyée ici, YouTube, ou l'image de la série (aucun fond propre)
  // 1) le fichier arrive (corps brut) ; 2) POST …/background { type: 'file', file } l'attribue à l'extrait
  router.put('/library/:clipId/background', (req, res) => {
    const ext = extname(String(req.query.name || '')).slice(1).toLowerCase();
    if (!BACKGROUND_EXT.test(ext)) return res.status(400).json({ error: 'Choisissez une image JPG, PNG, WebP ou AVIF, ou une vidéo MP4 ou WebM.' });
    const file = randomUUID() + '.' + ext;
    return receiveBackground(req, res, join(clipsDir, file), { file });
  });
  router.post('/library/:clipId/background', (req, res) => {
    const clip = content.find((c) => c.id === req.params.clipId);
    const old = clip.background;
    if (req.body?.type === 'file') {
      const file = String(req.body.file || '');
      if (!BACKGROUND_FILE.test(file) || !existsSync(join(clipsDir, file))) return res.status(400).json({ error: 'Fichier de fond introuvable. Renvoyez-le.' });
      clip.background = { type: /\.(mp4|webm)$/.test(file) ? 'video' : 'image', file };
    } else if (req.body?.type === 'youtube') {
      const videoId = youtubeId(String(req.body.url || ''));
      if (!videoId) return res.status(400).json({ error: 'Indiquez un lien YouTube valide.' });
      clip.background = { type: 'youtube', videoId };
    } else if (req.body?.type === 'none') {
      delete clip.background;
    } else return res.status(400).json({ error: 'Choisissez un fond valide.' });
    clip.updatedAt = Date.now();
    saveContent();
    dropBackground(old);
    res.json(summary(clip));
  });

  router.delete('/library/:clipId', (req, res) => { removeClip(req.params.clipId); res.json({ ok: true }); });

  // chanson commencée sans extrait : on efface le média et son analyse
  router.delete('/library/media/:mediaId', (req, res) => {
    const id = req.params.mediaId;
    if (!MEDIA_ID.test(id) || !existsSync(metaFile(id))) return res.status(404).json({ error: 'Ce média n’existe plus.' });
    if (readMeta(id)?.status === 'working') return res.status(409).json({ error: 'Ce média est en cours de traitement.' });
    if (content.some((c) => mediaOf(c.id) === id)) return res.status(409).json({ error: 'Supprimez d’abord ses extraits.' });
    rmSync(join(workshopRoot, id), { recursive: true, force: true });
    res.json({ ok: true });
  });

  return { router, removeClip };
}

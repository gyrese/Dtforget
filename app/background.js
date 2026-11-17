import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const BACKGROUND_EXT = /^(?:jpg|jpeg|png|webp|avif|mp4|webm)$/;
export const BACKGROUND_FILE = /^[a-f0-9-]{36}\.(?:jpg|jpeg|png|webp|avif|mp4|webm)$/;
export const BACKGROUND_LIMIT = 800 * 1024 * 1024;

export function youtubeId(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^(www|m)\./, '');
    const parts = url.pathname.split('/');
    const id = host === 'youtu.be' ? parts[1] : host === 'youtube.com'
      ? (url.pathname === '/watch' ? url.searchParams.get('v') : ['embed', 'shorts', 'live'].includes(parts[1]) ? parts[2] : null)
      : null;
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

export async function receiveBackground(req, res, file, result) {
  if (Number(req.headers['content-length']) > BACKGROUND_LIMIT) {
    return res.status(413).json({ error: 'Fond trop volumineux (800 Mo maximum).' });
  }
  const temp = file + '.' + randomUUID() + '.part';
  let size = 0;
  let oversized = false;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      oversized = size > BACKGROUND_LIMIT;
      done(oversized ? new Error('Taille maximale dépassée') : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(temp, { flags: 'wx' }));
    if (!size) return res.status(400).json({ error: 'Fichier vide.' });
    await rename(temp, file);
    res.json(result);
  } catch {
    if (!res.destroyed) res.status(oversized ? 413 : 500).json({ error: 'Impossible d’enregistrer le fond.' });
  } finally {
    await rm(temp, { force: true });
  }
}

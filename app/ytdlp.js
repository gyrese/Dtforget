// Téléchargement d'une vidéo YouTube pour l'atelier, avec yt-dlp.
// L'atelier garde son propre yt-dlp (data/bin) : téléchargé au premier lien, mis à jour tout seul quand YouTube
// change et que le téléchargement échoue. Il sert sur la machine qui fait l'analyse (ce PC, ou le PC relié au serveur).
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + ASSET;
// vidéo H.264 (lisible en fond par tous les navigateurs) jusqu'en 1080p, sinon ce qui existe
const FORMAT = 'bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*[height<=1080]+ba/b';

export function createYtDlp(binDir) {
  const exe = join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  let installing = null;

  async function install() {
    mkdirSync(binDir, { recursive: true });
    const res = await fetch(RELEASE, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('Téléchargement de yt-dlp impossible.');
    await pipeline(Readable.fromWeb(res.body), createWriteStream(exe + '.part', { mode: 0o755 }));
    renameSync(exe + '.part', exe);
  }
  const ensure = () => existsSync(exe) ? Promise.resolve() : (installing ||= install().finally(() => { installing = null; }));

  const exec = (args, onLine = () => {}) => new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = '', err = '';
    // l'avancement arrive sur l'une ou l'autre sortie selon le mode de yt-dlp
    child.stdout.on('data', (c) => { out += c; for (const line of String(c).split(/\r?\n/)) if (line) onLine(line); });
    child.stderr.on('data', (c) => { err = (err + c).slice(-4000); for (const line of String(c).split(/\r?\n/)) if (line.startsWith('@@')) onLine(line); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(Object.assign(new Error(err.trim().split('\n').pop() || 'yt-dlp a échoué.'), { stderr: err })));
  });

  // url : lien YouTube déjà vérifié ; écrit <dir>/source.mp4 et rend { title, artist } tirés de la vidéo
  async function download(url, dir, onProgress = () => {}) {
    await ensure();
    const args = ['--no-playlist', '--no-warnings', '--newline', '--progress', '--no-part', '--max-filesize', '800M',
      '-f', FORMAT, '--merge-output-format', 'mp4', '-o', join(dir, 'source.%(ext)s'),
      '--progress-template', 'download:@@%(progress._percent_str)s',
      '--no-simulate', '--print', 'after_move:@@info %(duration)s\t%(track)s\t%(artist)s\t%(title)s\t%(uploader)s', url];
    let info = null;
    const onLine = (line) => {
      if (line.startsWith('@@info ')) info = line.slice(7).split('\t');
      else if (line.startsWith('@@')) onProgress(line.slice(2).trim());
    };
    const attempt = () => exec(args, onLine);
    try { await attempt(); }
    catch (error) {
      if (/private|unavailable|not available|removed|copyright|sign in to confirm your age/i.test(error.stderr || '')) throw new Error('Cette vidéo YouTube n’est pas accessible (privée, supprimée ou réservée).');
      // YouTube change souvent : on met yt-dlp à jour et on réessaie une fois
      for (const f of readdirSync(dir)) if (f.startsWith('source.')) rmSync(join(dir, f), { force: true });
      await exec(['-U']).catch(() => install());
      try { await attempt(); }
      catch (again) { throw new Error('Téléchargement YouTube impossible : ' + again.message.replace(/^ERROR:\s*/, '').slice(0, 200)); }
    }
    const name = readdirSync(dir).find((f) => f.startsWith('source.'));
    if (!name) throw new Error('Téléchargement YouTube impossible (fichier trop gros ?).');
    if (name !== 'source.mp4') renameSync(join(dir, name), join(dir, 'source.mp4'));
    const [duration, track, artist, title, uploader] = (info || []).map((x) => (x === 'NA' ? '' : x.trim()));
    if (Number(duration) > 600) throw new Error('Cette vidéo dépasse 10 minutes.');
    // « Artiste - Titre (Clip officiel) » : on sépare et on retire le superflu
    const clean = (s) => s.replace(/[([][^)\]]*(officiel|official|clip|lyrics?|paroles|audio|video|vidéo|hd|4k)[^)\]]*[)\]]/gi, ' ').replace(/\s+/g, ' ').trim();
    const parts = clean(title || '').split(/\s[-–—|]\s/);
    return track
      ? { title: clean(track), artist: artist || '' }
      : parts.length > 1 ? { artist: parts[0], title: parts.slice(1).join(' - ') } : { title: parts[0] || '', artist: artist || (uploader || '').replace(/\s*-\s*Topic$/, '') };
  }

  return { download };
}

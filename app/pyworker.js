// Lance spike/atelier.py pour un traitement de l'atelier (analyse, alignement, extrait).
// Utilisé par le serveur quand l'atelier tourne sur place, et par agent.js quand le PC travaille pour le serveur en ligne.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createYtDlp } from './ytdlp.js';

export function createPyWorker(spikeDir, { binDir } = {}) {
  const yt = createYtDlp(binDir || join(spikeDir, '..', 'app', 'data', 'bin'));
  const python = process.env.ATELIER_PYTHON || (process.platform === 'win32' ? join(spikeDir, '.venv', 'Scripts', 'python.exe') : join(spikeDir, '.venv', 'bin', 'python'));

  // job : { cmd: 'analyze', title, artist, url? } | { cmd: 'align', lrclibId | text } | { cmd: 'build', first, last }
  async function runJob(dir, job, onStep = () => {}) {
    // lien YouTube : la vidéo est d'abord téléchargée ici (source.mp4), puis l'analyse s'enchaîne ;
    // le titre et l'artiste laissés vides sont tirés de la vidéo
    let found = null;
    if (job.cmd === 'analyze' && job.url && !readdirSync(dir).some((f) => f.startsWith('source.'))) {
      onStep('download');
      found = await yt.download(job.url, dir, (pct) => onStep('download:' + pct));
      job = { ...job, title: job.title || found.title, artist: job.artist || found.artist };
      if (!job.title) throw new Error('Indiquez le titre de la chanson : la vidéo n’en donne pas.');
    }
    const done = await runPython(dir, job, onStep);
    return found ? { ...done, title: job.title, artist: job.artist } : done;
  }

  function runPython(dir, job, onStep) {
    let args;
    if (job.cmd === 'analyze') args = ['analyze', dir, '--title', String(job.title || ''), '--artist', String(job.artist || '')];
    else if (job.cmd === 'align') {
      args = ['align', dir];
      if (Number.isInteger(job.lrclibId)) args.push('--lrclib', String(job.lrclibId));
      else writeFileSync(join(dir, 'lyrics_input.txt'), String(job.text || ''), 'utf8');
    } else if (job.cmd === 'build') {
      args = ['build', dir, '--first', String(job.first), '--last', String(job.last)];
      // bornes choisies à la main sur l'aperçu (secondes dans la chanson)
      if (Number.isFinite(job.start)) args.push('--start', String(job.start));
      if (Number.isFinite(job.end)) args.push('--end', String(job.end));
      if (Number.isFinite(job.cut)) args.push('--cut', String(job.cut));
      if (Number.isFinite(job.lyricsOffset)) args.push('--lyrics-offset', String(job.lyricsOffset));
    }
    else return Promise.reject(new Error('Traitement inconnu.'));

    return new Promise((resolve, reject) => {
      let done = null, failure = null, stderr = '', settled = false;
      const child = spawn(python, ['-W', 'ignore', 'atelier.py', ...args], { cwd: spikeDir, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith('@@')) return;
        try {
          const msg = JSON.parse(line.slice(2));
          if (msg.step) onStep(msg.step);
          if (msg.done) done = msg;
          if (msg.error) failure = msg.error;
        } catch { /* ligne de journal */ }
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (code === 0 && done) return resolve(done);
        console.error(`[atelier] ${job.cmd} a échoué dans ${dir} :\n${stderr}`);
        reject(new Error(failure || 'Le traitement a échoué. Détails dans le journal du PC de traitement.'));
      };
      child.on('error', (error) => { stderr += String(error); finish(1); });
      child.on('close', finish);
    });
  }

  return { runJob };
}

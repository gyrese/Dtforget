// Espace admin du serveur en ligne : avec le mot de passe admin, on télécharge l'application de l'atelier
// et on obtient le code qui la relie à ce serveur.
import express from 'express';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';

const EXE_URL = process.env.ATELIER_EXE_URL || 'https://github.com/gyrese/Dtforget/releases/download/atelier/DtForget-Atelier.exe';

export function createAdmin({ password, publicUrl, token }) {
  const router = express.Router();
  const tries = new Map(); // ip -> { n, until } : freine les essais de mot de passe
  const check = (req, res) => {
    if (!password) { res.status(404).json({ error: 'Espace admin désactivé : réglez ADMIN_PASSWORD sur le serveur.' }); return false; }
    const ip = req.ip || 'ip', t = tries.get(ip) || { n: 0, until: 0 };
    if (t.until > Date.now()) { res.status(429).json({ error: 'Trop d’essais. Réessayez dans une minute.' }); return false; }
    const a = Buffer.from(String(req.body?.password || '')), b = Buffer.from(password);
    if (a.length === b.length && timingSafeEqual(a, b)) { tries.delete(ip); return true; }
    t.n += 1;
    if (t.n >= 5) { t.n = 0; t.until = Date.now() + 60000; }
    tries.set(ip, t);
    res.status(401).json({ error: 'Mot de passe incorrect.' });
    return false;
  };
  const linkCode = () => publicUrl && token
    ? 'dtf1.' + Buffer.from(JSON.stringify({ u: publicUrl.replace(/\/+$/, ''), t: token })).toString('base64url')
    : null;

  router.post('/login', express.json({ limit: '4kb' }), (req, res) => {
    if (!check(req, res)) return;
    res.json({ ok: true, link: linkCode(), server: publicUrl || null });
  });

  // téléchargement par formulaire (mot de passe dans le corps) : le serveur relaie le fichier publié sur GitHub
  router.post('/atelier.exe', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    if (!check(req, res)) return;
    try {
      const r = await fetch(EXE_URL, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (!r.ok || !r.body) throw new Error(String(r.status));
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="DtForget-Atelier.exe"', 'Cache-Control': 'no-store' });
      if (r.headers.get('content-length')) res.set('Content-Length', r.headers.get('content-length'));
      Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
    } catch { if (!res.headersSent) res.status(502).json({ error: 'L’application n’est pas disponible pour le moment. Réessayez plus tard.' }); }
  });

  return router;
}

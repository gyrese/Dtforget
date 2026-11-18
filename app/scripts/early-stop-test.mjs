// Fin anticipée du chrono : tous les joueurs ont répondu, ou la télécommande l'arrête.
// Prérequis : serveur lancé (npm start), avec INTRO_MS court de préférence. Usage : node scripts/early-stop-test.mjs
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'OK    ' : 'ECHEC ') + msg); if (!ok) failures++; };
const connect = () => io(BASE, { forceNew: true, transports: ['websocket'] });
const once = (s, ev, ms = 60000) => new Promise((ok, ko) => { const t = setTimeout(() => ko(new Error('attente trop longue : ' + ev)), ms); s.once(ev, (d) => { clearTimeout(t); ok(d); }); });
const call = (s, ev, data) => new Promise((ok) => s.emit(ev, data, ok));

const lib = await fetch(BASE + '/api/library').then((r) => r.json());
const listId = (lib.lists || lib).find?.((l) => l.id)?.id || 'disney';

const host = connect();
host.emit('host:create', { listId, rounds: 3, answerSeconds: 30 });
const { code } = await once(host, 'host:created');
const players = [connect(), connect()];
for (const [i, p] of players.entries()) await call(p, 'player:join', { code, name: 'Test' + (i + 1) });
const remote = connect();
check((await call(remote, 'remote:join', { code })).ok, 'télécommande connectée avec le seul code');

// manche 1 : les deux joueurs répondent → révélation sans attendre les 30 s
host.emit('host:start');
await once(players[0], 'answer:open');
let t0 = Date.now();
const reveal1 = once(host, 'reveal', 5000);
await call(players[0], 'player:answer', { text: 'a' });
await call(players[1], 'player:answer', { text: 'b' });
await reveal1.then(() => check(Date.now() - t0 < 2000, 'révélation dès que tout le monde a répondu'), (e) => check(false, e.message));

// manche 2 : un seul joueur répond, la télécommande arrête le chrono
host.emit('host:next');
await once(players[0], 'answer:open');
await call(players[0], 'player:answer', { text: 'a' });
let revealedAt = 0;
host.once('reveal', () => { revealedAt = Date.now(); });
await new Promise((r) => setTimeout(r, 1500));
check(!revealedAt, 'pas de révélation tant qu’un joueur n’a pas répondu');
t0 = Date.now();
remote.emit('remote:stop');
await new Promise((r) => setTimeout(r, 2000));
check(revealedAt && revealedAt - t0 < 2000, 'la télécommande arrête le chrono');

for (const s of [host, remote, ...players]) s.close();
console.log(failures ? failures + ' échec(s)' : 'Tout est bon.');
process.exit(failures ? 1 : 0);

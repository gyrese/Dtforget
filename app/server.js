// Serveur de jeu local : salons par code, manches (extrait -> trou -> réponse -> révélation).
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrary, songKey } from './library.js';
import { createWorkshop } from './workshop.js';
import { createPublisher } from './publish.js';
import { createRemoteRunner } from './remote.js';
import { createPyWorker } from './pyworker.js';
import { createAdmin } from './admin.js';
import { createCatalog } from './catalog.js';
import QRCode from 'qrcode';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { bedEnd, lastGap } from './timing.js';

// Adresse IPv4 du PC sur le réseau local (pour que le téléphone puisse ouvrir l'adresse du QR code).
function lanAddress() {
  const found = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    // les cartes virtuelles (Hyper-V, WSL, Docker, VPN…) ont aussi des adresses 192.168.x.x, injoignables depuis un téléphone
    if (/vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier|TAP|VPN/i.test(name)) continue;
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) found.push({ name, address: net.address });
    }
  }
  // le Wi-Fi d'abord, puis les réseaux privés domestiques (192.168.x.x, 10.x.x.x)
  const pick = found.find((n) => /wi-?fi|wlan/i.test(n.name)) || found.find((n) => n.address.startsWith('192.168.')) || found.find((n) => n.address.startsWith('10.')) || found[0];
  return pick ? pick.address : 'localhost';
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(here, "data");
const CONTENT_FILE = join(DATA_DIR, "content.json");
const CONTENT = existsSync(CONTENT_FILE) ? JSON.parse(readFileSync(CONTENT_FILE, "utf-8")) : [];
const library = createLibrary(CONTENT, process.env.LISTS_FILE || join(DATA_DIR, 'lists.json'));
const CLIPS_DIR = join(DATA_DIR, 'clips');
const LEGACY_CLIPS = join(here, '..', 'spike', 'out', 'ECOUTE');
const ROUNDS = 5;          // nombre de manches par partie
const INTRO_MS = Number(process.env.INTRO_MS || 3000);     // présentation avant l'extrait
const ANSWER_MS = Number(process.env.ANSWER_MS || 60000);   // chrono par défaut, après l'instrumental (réglable à la création du salon)
const PORT = Number(process.env.PORT || 3000);
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS || 600000);
const PLAYER_GRACE_MS = Number(process.env.PLAYER_GRACE_MS || 8000);

const app = express();
// Self-hosted animation runtimes: the Host also works without a public CDN.
app.get('/vendor/animejs/anime.umd.min.js', (_req, res) => res.sendFile(join(here, 'node_modules', 'animejs', 'dist', 'bundles', 'anime.umd.min.js')));
app.get('/vendor/gsap/gsap.min.js', (_req, res) => res.sendFile(join(here, 'node_modules', 'gsap', 'dist', 'gsap.min.js')));
app.get('/vendor/lottie/lottie_light.min.js', (_req, res) => res.sendFile(join(here, 'node_modules', 'lottie-web', 'build', 'player', 'lottie_light.min.js')));
const publisher = createPublisher({ content: CONTENT, contentFile: CONTENT_FILE, library, clipsDir: CLIPS_DIR, legacyDir: LEGACY_CLIPS, removeClip: (id) => catalog.removeClip(id) });
app.use('/api/import', publisher.importer); // avant le parseur JSON général : corps audio brut et listes volumineuses
app.use(express.json({ limit: '1mb' }));
app.get('/api/library', (_req, res) => res.json(library.get()));
for (const method of ['post', 'put']) app[method](method === 'post' ? '/api/lists' : '/api/lists/:id', (req, res) => {
  try { res.json(library.save(req.params.id, req.body)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.use('/api/publish', publisher.sender);
// mot de passe admin : ADMIN_PASSWORD, ou à défaut le code de l'atelier
app.use('/api/admin', createAdmin({ password: process.env.ADMIN_PASSWORD || process.env.ATELIER_PIN || '', publicUrl: process.env.PUBLIC_URL || '', token: process.env.IMPORT_TOKEN || '' }));
app.use('/media', express.static(CLIPS_DIR));
app.use(express.static(join(here, "public")));
app.use("/clips", express.static(LEGACY_CLIPS));
app.get("/", (_req, res) => res.redirect("/host.html"));
app.get("/api/content-count", (_req, res) => res.json({ clips: CONTENT.length }));

const http = createServer(app);
const io = new Server(http, { cors: { origin: "*" } });
http.once("close", () => io.engine.close());

// Atelier : sur place (ce PC a le Python du spike et la carte graphique), ou « remote » sur le serveur en ligne,
// où les traitements sont confiés au PC qui s'y connecte (agent.js). ATELIER=off le retire.
const ATELIER = ['off', 'remote'].includes(process.env.ATELIER) ? process.env.ATELIER : 'local';
const ATELIER_PIN = process.env.ATELIER_PIN || '';
let workshop = null, remote = null;
const catalog = createCatalog({ content: CONTENT, contentFile: CONTENT_FILE, library, clipsDir: CLIPS_DIR, workshopRoot: join(DATA_DIR, 'workshop') });
if (ATELIER === 'remote' && process.env.IMPORT_TOKEN) {
  remote = createRemoteRunner({ io, root: join(DATA_DIR, 'workshop'), token: process.env.IMPORT_TOKEN });
  app.use('/api/agent', remote.router);
  workshop = createWorkshop({ dataDir: DATA_DIR, content: CONTENT, contentFile: CONTENT_FILE, library, catalog, runner: remote });
} else if (ATELIER === 'local') {
  const py = createPyWorker(join(here, '..', 'spike'), { binDir: join(DATA_DIR, 'bin') });
  workshop = createWorkshop({ dataDir: DATA_DIR, content: CONTENT, contentFile: CONTENT_FILE, library, catalog, runner: { run: (_id, dir, job, onStep) => py.runJob(dir, job, onStep) } });
}
if (workshop) {
  // code d'accès facultatif (ATELIER_PIN) ; la lecture audio passe sans, son adresse contient un identifiant non devinable
  app.use('/api/workshop', (req, res, next) => {
    if (!ATELIER_PIN || (req.method === 'GET' && req.path.endsWith('/audio')) || req.headers['x-atelier-pin'] === ATELIER_PIN) return next();
    res.status(401).json({ error: 'Code d’accès requis.' });
  }, catalog.router, workshop.router); // bibliothèque d'abord : /library ne doit pas passer pour un identifiant de média
}
app.get('/api/config', (_req, res) => res.json({
  atelier: workshop ? ATELIER : false, pin: Boolean(workshop && ATELIER_PIN), pc: remote ? remote.connected() : null,
  publish: publisher.enabled, publishTarget: publisher.enabled ? publisher.target : null,
  // application de bureau : l'atelier est la seule page, les extraits partent tout seuls vers le serveur en ligne
  app: process.env.APP_MODE === '1',
}));

const rooms = new Map();
const hostSessions = new Map();
const validToken = (token) => typeof token === "string" && /^[a-f0-9-]{32,36}$/i.test(token);
const findRoom = (code) => typeof code === "string" ? rooms.get(code.trim().toUpperCase()) : undefined;

function code4() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let c;
  do {
    c = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(c));
  return c;
}

// Normalisation mot par mot : minuscules, sans accents ni ponctuation.
function tokens(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Plus longue sous-séquence commune, en mots : score = mots justes / mots attendus.
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

// 2 points pour la réponse exacte, 1 point si plus de la moitié des mots sont justes, dans l'ordre
// (majuscules, accents et ponctuation ignorés)
function score(answerText, expectedText) {
  const exp = tokens(expectedText);
  const got = tokens(answerText || "");
  if (!exp.length || !got.length) return 0;
  if (got.join(" ") === exp.join(" ")) return 2;
  return lcs(got, exp) / exp.length > 0.5 ? 1 : 0;
}

function pick(n, source = CONTENT) {
  const films = new Set();
  const pool = [...source].sort(() => Math.random() - 0.5);
  const out = [];
  for (const c of pool) {
    if (films.has(songKey(c))) continue;
    films.add(songKey(c));
    out.push(c);
    if (out.length === n) break;
  }
  return out;
}

const playerList = (room) => [...room.players.values()].map((p) => ({ name: p.name, score: p.score, connected: Boolean(p.socketId) }));
const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.socketId).length;
const answerCount = (room) => [...room.players.values()].filter((p) => p.answer !== null).length;
const tellHost = (room, event, data) => { if (room.hostId) io.to(room.hostId).emit(event, data); };
const broadcastPlayers = (room) => tellHost(room, "players:update", playerList(room));

function playerState(room, player) {
  const state = {
    ok: true, code: room.code, name: player.name, score: player.score,
    round: room.round + 1, total: room.songs.length, state: room.state,
    answering: room.state === "answering", answered: player.answer !== null,
  };
  if (room.state === "reveal") state.result = { answer: room.reveal.answer, points: player.points };
  if (room.state === "over") state.rank = { position: player.rank, total: room.players.size };
  return state;
}

function pushPlayerResults(room) {
  for (const player of room.players.values()) {
    if (player.socketId) io.to(player.socketId).emit("player:state", playerState(room, player));
  }
}

function closeRoom(room) {
  clearTimers(room);
  clearTimeout(room.hostExpiry);
  for (const player of room.players.values()) clearTimeout(player.disconnectTimer);
  io.to(room.code).emit("room:closed");
  io.to(room.code + ":remote").emit("remote:closed");
  io.in(room.code).socketsLeave(room.code);
  io.in(room.code + ":remote").socketsLeave(room.code + ":remote");
  rooms.delete(room.code);
  hostSessions.delete(room.hostToken);
}

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
}

function startRound(room) {
  const clip = room.songs[room.round];
  room.state = "intro";
  for (const p of room.players.values()) {
    clearTimeout(p.disconnectTimer);
    p.waitUntil = 0;
    p.answer = null;
    p.points = 0;
  }
  pushRemote(room);
  room.intro = {
    round: room.round + 1,
    total: room.songs.length,
    film: clip.film,
    title: clip.title,
  };
  io.to(room.code).emit("round:intro", room.intro);
  room.timers.push(setTimeout(() => {
    room.state = "playing";
    room.clipStartedAt = Date.now();
    pushRemote(room);
    room.clip = {
      audio: clip.audio,
      background: clip.background,
      cutAt: clip.cutAt,
      bedEnd: bedEnd(clip), // l'instrumental s'arrête ici, le chrono prend le relais
      revealAt: clip.revealAt ?? null, // même fichier : la reprise chantée commence ici
      // le mot à trouver n'est jamais envoyé à l'écran : seulement sa place
      // mot à trouver : un tiret bas par lettre (ponctuation retirée), le texte n'est jamais envoyé
      // rien après le trou : la suite n'est plus chantée pendant la manche
      words: clip.words.slice(0, lastGap(clip) + 1).map((w) => (w.gap ? { ...w, x: w.x.replace(/[\p{L}\p{N}]/gu, "_") } : w)),
      answerLength: clip.answer.split(" ").length,
    };
    tellHost(room, "round:clip", room.clip);
    room.timers.push(setTimeout(() => openAnswer(room, clip), clip.cutAt * 1000));
  }, INTRO_MS));
}

function openAnswer(room, clip) {
  room.state = "answering";
  // on peut répondre dès la coupure ; le chrono démarre quand l'instrumental s'arrête
  const music = Math.max(0, bedEnd(clip) - clip.cutAt);
  const timer = room.answerMs / 1000;
  room.answerStartedAt = Date.now();
  room.answerWindow = { round: room.round + 1, seconds: music + timer, music, timer, answerLength: clip.answer.split(" ").length };
  io.to(room.code).emit("answer:open", room.answerWindow);
  pushRemote(room);
  room.timers.push(setTimeout(() => reveal(room, clip), (music + timer) * 1000));
}

// Un joueur en cours de reconnexion dispose d'un court délai pour terminer sa réponse.
function finishIfAnswered(room) {
  if (room.state !== "answering" || !answerCount(room)) return;
  const now = Date.now();
  if ([...room.players.values()].every((p) => p.answer !== null || (!p.socketId && p.waitUntil <= now))) stopAnswers(room);
}

// fin anticipée du chrono : tout le monde a répondu, ou le présentateur l'arrête
function stopAnswers(room) {
  if (room.state !== "answering") return;
  clearTimers(room);
  reveal(room, room.songs[room.round]);
}

function reveal(room, clip) {
  room.state = "reveal";
  room.revealStartedAt = Date.now();
  const ranking = [...room.players.values()]
    .map((p) => {
      const pts = score(p.answer, clip.answer);
      p.score += pts;
      p.points = pts;
      return { name: p.name, text: p.answer || "", points: pts };
    })
    .sort((a, b) => b.points - a.points);
  room.reveal = { answer: clip.answer, film: clip.film, title: clip.title, ranking, last: room.round + 1 >= room.songs.length };
  io.to(room.code).emit("reveal", room.reveal);
  pushPlayerResults(room);
  broadcastPlayers(room);
  pushRemote(room);
  // la manche suivante attend le présentateur (télécommande /remote.html ou bouton de l'écran)
}

function nextRound(room) {
  if (room.state !== "reveal") return;
  clearTimers(room);
  room.round += 1;
  if (room.round >= room.songs.length) {
    room.round = room.songs.length - 1;
    room.state = "over";
    room.final = [...room.players.values()].sort((a, b) => b.score - a.score).map((p, index) => {
      p.rank = index + 1;
      return { name: p.name, score: p.score };
    });
    io.to(room.code).emit("game:over", room.final);
    pushPlayerResults(room);
    pushRemote(room);
  } else {
    startRound(room);
  }
}

// télécommande du présentateur : état de la partie
function remoteState(room) {
  const clip = room.songs[room.round];
  return {
    state: room.state, round: room.round + 1, total: room.songs.length,
    title: clip?.title || "", film: clip?.film || "",
    players: room.players.size, connected: connectedPlayers(room), answers: answerCount(room), hostOnline: Boolean(room.hostId),
    answer: room.state === "reveal" ? clip?.answer || "" : null,
  };
}

const pushRemote = (room) => io.to(room.code + ":remote").emit("remote:state", remoteState(room));

function hostState(room) {
  const now = Date.now();
  const state = { ...room.invite, ok: true, state: room.state, players: playerList(room) };
  if (room.state !== "lobby") state.intro = room.intro;
  if (room.state === "playing" || room.state === "answering") {
    state.clip = { ...room.clip, elapsed: (now - room.clipStartedAt) / 1000 };
  }
  if (room.state === "answering") {
    state.answerWindow = { ...room.answerWindow, elapsed: (now - room.answerStartedAt) / 1000 };
    state.answers = answerCount(room);
  }
  if (room.state === "reveal") {
    state.reveal = { ...room.reveal, elapsed: (now - room.revealStartedAt) / 1000, audio: room.clip.audio, revealAt: room.clip.revealAt };
  }
  if (room.state === "over") state.final = room.final;
  return state;
}

function inviteBase(origin) {
  for (const candidate of [process.env.PUBLIC_URL, origin]) {
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1", "0.0.0.0", "[::]", "[::1]"].includes(url.hostname)) return url.origin;
    } catch {}
  }
  return `http://${lanAddress()}:${PORT}`;
}

function attachHost(room, socket) {
  const previous = io.sockets.sockets.get(room.hostId);
  if (previous && previous !== socket) {
    previous.leave(room.code);
    previous.emit("host:replaced");
  }
  clearTimeout(room.hostExpiry);
  room.hostId = socket.id;
  socket.join(room.code);
  Object.assign(socket.data, { code: room.code, role: "host" });
}

function attachPlayer(room, player, socket) {
  const previous = io.sockets.sockets.get(player.socketId);
  if (previous && previous !== socket) {
    previous.leave(room.code);
    previous.emit("player:replaced");
  }
  clearTimeout(player.disconnectTimer);
  player.waitUntil = 0;
  player.socketId = socket.id;
  socket.join(room.code);
  Object.assign(socket.data, { code: room.code, role: "player", token: player.token });
}

io.on("connection", (socket) => {
  let remoteSession;
  function onRequest(event, handle) {
    socket.on(event, (input, ack) => {
      if (typeof input === "function") handle({}, input);
      else handle(input || {}, typeof ack === "function" ? ack : undefined);
    });
  }

  onRequest("host:create", async ({ listId = 'disney', rounds = ROUNDS, answerSeconds, token, origin }, ack) => {
    if (socket.data.role === "player") return;
    const existing = rooms.get(socket.data.code);
    if (existing?.hostId === socket.id) {
      if (existing.hostToken !== token) return ack?.({ ok: false, error: "Un salon est déjà ouvert sur cet écran." });
      await existing.inviteReady;
      if (existing.hostId === socket.id && socket.connected) ack?.(hostState(existing));
      return;
    }
    if (validToken(token) && hostSessions.has(token)) return ack?.({ ok: false, retry: true });
    const total = Number.isInteger(rounds) && rounds >= 1 && rounds <= 200 ? rounds : ROUNDS; // limité ensuite aux chansons de la liste
    const answerMs = [5, 10, 15, 20, 30, 60].includes(answerSeconds) ? answerSeconds * 1000 : ANSWER_MS;
    const songs = pick(total, library.clips(listId));
    if (!songs.length) {
      const error = 'Ajoutez au moins une chanson à cette liste.';
      if (ack) return ack({ ok: false, error });
      return socket.emit('host:error', error);
    }
    const code = code4();
    const hostToken = validToken(token) ? token : randomUUID();
    const base = inviteBase(origin);
    const joinUrl = `${base}/play.html?code=${code}`;
    const remote = { url: `${base}/remote.html?code=${code}` };
    const list = library.get().lists.find((entry) => entry.id === listId);
    const invite = { code, listId, list: list && { name: list.name, theme: list.theme, coverImage: list.coverImage }, rounds: songs.length, joinUrl, remote };
    const room = { code, hostToken, invite, players: new Map(), state: "lobby", round: 0, songs, timers: [], answerMs };
    rooms.set(code, room);
    hostSessions.set(hostToken, room);
    attachHost(room, socket);
    room.inviteReady = QRCode.toDataURL(joinUrl, { margin: 4, width: 260 }).then((qr) => { invite.qr = qr; }).catch(() => {});
    await room.inviteReady;
    if (room.hostId !== socket.id || !socket.connected) return;
    if (ack) ack(hostState(room));
    else socket.emit("host:created", invite);
  });

  onRequest("host:resume", async ({ token }, ack = () => {}) => {
    const room = hostSessions.get(token);
    if (!room || (socket.data.code && socket.data.code !== room.code) || socket.data.role === "player") return ack({ ok: false });
    attachHost(room, socket);
    await room.inviteReady;
    if (room.hostId !== socket.id || !socket.connected) return;
    ack(hostState(room));
    pushRemote(room);
  });

  onRequest('host:leave', (_input, ack) => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id) return ack?.({ ok: false });
    socket.leave(room.code);
    closeRoom(room);
    delete socket.data.code;
    delete socket.data.role;
    ack?.({ ok: true });
  });

  onRequest("player:join", ({ code, name, token }, ack = () => {}) => {
    const room = findRoom(code);
    if (!room) return ack({ ok: false, error: "Ce salon n'existe pas. Vérifiez le code." });
    const current = room.players.get(socket.data.token);
    const existing = validToken(token) ? room.players.get(token) : null;
    if (socket.data.role === "host" || (rooms.has(socket.data.code) && (socket.data.code !== room.code || (existing && existing !== current)))) {
      return ack({ ok: false, error: "Cette connexion est déjà utilisée dans un salon." });
    }
    const returning = existing || (current?.socketId === socket.id ? current : null);
    if (returning) {
      attachPlayer(room, returning, socket);
      ack({ ...playerState(room, returning), token: returning.token });
      broadcastPlayers(room);
      pushRemote(room);
      return;
    }
    if (room.state === "over") return ack({ ok: false, error: "Cette partie est terminée. Demandez le code du prochain salon." });
    const clean = typeof name === "string" ? name.trim().slice(0, 16) : "";
    if (!clean) return ack({ ok: false, error: "Entrez un pseudo." });
    const player = { token: validToken(token) ? token : randomUUID(), name: clean, score: 0, answer: null, points: 0 };
    room.players.set(player.token, player);
    attachPlayer(room, player, socket);
    ack({ ...playerState(room, player), token: player.token });
    broadcastPlayers(room);
    pushRemote(room);
  });

  // reprise d'une session joueur après rechargement ou coupure réseau
  onRequest("player:resume", ({ code, token }, ack = () => {}) => {
    const room = findRoom(code);
    const p = room && typeof token === "string" ? room.players.get(token) : null;
    if (!p || socket.data.role === "host" || (rooms.has(socket.data.code) && (socket.data.code !== room.code || socket.data.token !== token))) return ack({ ok: false });
    attachPlayer(room, p, socket);
    ack(playerState(room, p));
    broadcastPlayers(room);
    pushRemote(room);
  });

  socket.on("host:start", () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    if (!connectedPlayers(room)) return;
    room.round = 0;
    startRound(room);
  });
  onRequest("host:next", ({ round }) => {
    const room = rooms.get(socket.data.code);
    if (room && room.hostId === socket.id && (round === undefined || round === room.round + 1)) nextRound(room);
  });

  // télécommande du présentateur : le code du salon suffit
  onRequest("remote:join", ({ code }, ack = () => {}) => {
    const room = findRoom(code);
    if (!room) return ack({ ok: false, error: "Aucun salon avec ce code." });
    if (remoteSession) socket.leave(remoteSession.code + ":remote");
    remoteSession = { code: room.code, hostToken: room.hostToken };
    socket.join(room.code + ":remote");
    ack({ ok: true, code: room.code, state: remoteState(room) });
    pushRemote(room);
  });
  function remoteAction(event, state, run) {
    onRequest(event, ({ round }, ack = () => {}) => {
      const room = rooms.get(remoteSession?.code);
      if (!room || room.hostToken !== remoteSession.hostToken) return ack({ ok: false });
      if (!room.hostId || room.state !== state || (round !== undefined && round !== room.round + 1)) {
        return ack({ ok: false, state: remoteState(room) });
      }
      run(room);
      ack({ ok: true, state: remoteState(room) });
    });
  }
  remoteAction("remote:start", "lobby", (room) => { if (connectedPlayers(room)) tellHost(room, "remote:start"); });
  remoteAction("remote:next", "reveal", nextRound);
  remoteAction("remote:stop", "answering", stopAnswers);

  onRequest("player:answer", ({ text, round }, ack = () => {}) => {
    const room = rooms.get(socket.data.code);
    const p = room?.players.get(socket.data.token);
    if (!p || p.socketId !== socket.id) return ack({ ok: false });
    const answer = typeof text === "string" ? text.trim().slice(0, 120) : "";
    if (room.state !== "answering" || (round !== undefined && round !== room.round + 1) || !answer) {
      return ack({ ok: false, state: playerState(room, p) });
    }
    if (p.answer !== null) return ack({ ok: true, state: playerState(room, p) });
    p.answer = answer;
    ack({ ok: true, state: playerState(room, p) });
    tellHost(room, "answers:count", answerCount(room));
    pushRemote(room);
    finishIfAnswered(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    if (room.hostId === socket.id) {
      room.hostId = null;
      pushRemote(room);
      room.hostExpiry = setTimeout(() => closeRoom(room), HOST_GRACE_MS);
      room.hostExpiry.unref();
      return;
    }
    // un joueur déconnecté garde sa place et son score : il peut reprendre avec player:resume
    const p = room.players.get(socket.data.token);
    if (p && p.socketId === socket.id) {
      p.socketId = null;
      if (["intro", "playing", "answering"].includes(room.state) && p.answer === null) {
        p.waitUntil = Date.now() + PLAYER_GRACE_MS;
        p.disconnectTimer = setTimeout(() => {
          if (rooms.get(room.code) === room) finishIfAnswered(room);
        }, PLAYER_GRACE_MS);
      }
      broadcastPlayers(room);
      pushRemote(room);
      finishIfAnswered(room);
    }
  });
});

const port = PORT;
http.listen(port, process.env.HOST || undefined, () => {
  console.log(`DtForget jeu local : http://localhost:${port}`);
  console.log(`Hôte (TV) : http://localhost:${port}/host.html`);
  console.log(`Joueurs (téléphone) : http://${lanAddress()}:${port}/play.html`);
  console.log(`${CONTENT.length} extraits chargés`);
});

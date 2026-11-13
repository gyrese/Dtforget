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
import QRCode from 'qrcode';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';

// Adresse IPv4 du PC sur le réseau local (pour que le téléphone puisse ouvrir l'adresse du QR code).
function lanAddress() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) found.push(net.address);
    }
  }
  // préfère les réseaux privés domestiques (192.168.x.x, 10.x.x.x), ignore les adresses APIPA 169.254.x.x
  return found.find((a) => a.startsWith('192.168.')) || found.find((a) => a.startsWith('10.')) || found[0] || 'localhost';
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
const ANSWER_MS = Number(process.env.ANSWER_MS || 15000);   // temps de réponse après la coupure
const REVEAL_MS = Number(process.env.REVEAL_MS || 7000);    // durée de la révélation
const PORT = Number(process.env.PORT || 3000);

const app = express();
// Self-hosted animation runtimes: the Host also works without a public CDN.
app.get('/vendor/animejs/anime.umd.min.js', (_req, res) => res.sendFile(join(here, 'node_modules', 'animejs', 'dist', 'bundles', 'anime.umd.min.js')));
app.get('/vendor/gsap/gsap.min.js', (_req, res) => res.sendFile(join(here, 'node_modules', 'gsap', 'dist', 'gsap.min.js')));
app.get('/vendor/lottie/lottie_light.min.js', (_req, res) => res.sendFile(join(here, 'node_modules', 'lottie-web', 'build', 'player', 'lottie_light.min.js')));
const publisher = createPublisher({ content: CONTENT, contentFile: CONTENT_FILE, library, clipsDir: CLIPS_DIR, legacyDir: LEGACY_CLIPS });
app.use('/api/import', publisher.importer); // avant le parseur JSON général : corps audio brut et listes volumineuses
app.use(express.json({ limit: '1mb' }));
app.get('/api/library', (_req, res) => res.json(library.get()));
for (const method of ['post', 'put']) app[method](method === 'post' ? '/api/lists' : '/api/lists/:id', (req, res) => {
  try { res.json(library.save(req.params.id, req.body)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
// L'atelier a besoin du Python du spike et d'une carte graphique : il est absent de l'image du serveur en ligne.
const workshop = process.env.ATELIER === 'off' ? null : createWorkshop({ dataDir: DATA_DIR, spikeDir: join(here, '..', 'spike'), content: CONTENT, contentFile: CONTENT_FILE, library });
if (workshop) app.use('/api/workshop', workshop.router);
app.use('/api/publish', publisher.sender);
app.get('/api/config', (_req, res) => res.json({ atelier: Boolean(workshop), publish: publisher.enabled, publishTarget: publisher.enabled ? publisher.target : null }));
app.use('/media', express.static(CLIPS_DIR));
app.use(express.static(join(here, "public")));
app.use("/clips", express.static(LEGACY_CLIPS));
app.get("/", (_req, res) => res.redirect("/host.html"));
app.get("/api/content-count", (_req, res) => res.json({ clips: CONTENT.length }));

const http = createServer(app);
const io = new Server(http, { cors: { origin: "*" } });

const rooms = new Map();

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

function score(answerText, expectedText) {
  const exp = tokens(expectedText);
  const got = tokens(answerText || "");
  if (!exp.length) return 0;
  // pénalité des mots en trop, sans bonus de vitesse
  const hits = lcs(got, exp);
  const extra = Math.max(0, got.length - exp.length);
  return Math.max(0, Math.round((100 * (hits - 0.5 * extra)) / exp.length));
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

function broadcastPlayers(room) {
  io.to(room.hostId).emit("players:update", [...room.players.values()].map((p) => ({ name: p.name, score: p.score })));
}

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
}

function startRound(room) {
  const clip = room.songs[room.round];
  room.state = "intro";
  room.answering = false;
  for (const p of room.players.values()) p.answer = null;
  io.to(room.code).emit("round:intro", {
    round: room.round + 1,
    total: room.songs.length,
    film: clip.film,
    title: clip.title,
  });
  room.timers.push(setTimeout(() => {
    room.state = "playing";
    io.to(room.hostId).emit("round:clip", {
      audio: clip.audio,
      cutAt: clip.cutAt,
      // le mot à trouver n'est jamais envoyé à l'écran : seulement sa place
      // mot à trouver : un tiret bas par lettre (ponctuation retirée), le texte n'est jamais envoyé
      words: clip.words.map((w) => (w.gap ? { ...w, x: w.x.replace(/[\p{L}\p{N}]/gu, "_") } : w)),
      answerLength: clip.answer.split(" ").length,
    });
    room.timers.push(setTimeout(() => openAnswer(room, clip), clip.cutAt * 1000));
  }, INTRO_MS));
}

function openAnswer(room, clip) {
  room.state = "answering";
  room.answering = true;
  io.to(room.code).emit("answer:open", { seconds: ANSWER_MS / 1000, answerLength: clip.answer.split(" ").length });
  room.timers.push(setTimeout(() => reveal(room, clip), ANSWER_MS));
}

function reveal(room, clip) {
  room.state = "reveal";
  room.answering = false;
  const ranking = [...room.players.values()]
    .map((p) => {
      const pts = score(p.answer, clip.answer);
      p.score += pts;
      return { name: p.name, text: p.answer || "", points: pts };
    })
    .sort((a, b) => b.points - a.points);
  io.to(room.code).emit("reveal", { answer: clip.answer, film: clip.film, title: clip.title, ranking });
  broadcastPlayers(room);
  room.timers.push(setTimeout(() => {
    room.round += 1;
    if (room.round >= room.songs.length) {
      room.state = "over";
      io.to(room.code).emit("game:over", [...room.players.values()].map((p) => ({ name: p.name, score: p.score })).sort((a, b) => b.score - a.score));
    } else {
      startRound(room);
    }
  }, REVEAL_MS));
}

io.on("connection", (socket) => {
  socket.on("host:create", ({ listId = 'disney', rounds = ROUNDS } = {}) => {
    if (socket.data.code) return;
    const total = [3, 5, 10].includes(rounds) ? rounds : ROUNDS;
    const songs = pick(total, library.clips(listId));
    if (!songs.length) return socket.emit('host:error', 'Ajoutez au moins une chanson à cette liste.');
    const code = code4();
    const room = { code, hostId: socket.id, players: new Map(), state: "lobby", round: 0, songs, timers: [], answering: false };
    rooms.set(code, room);
    socket.join(code);
    socket.data.code = code;
    socket.data.role = "host";
    // en ligne, PUBLIC_URL donne l'adresse publique (https://…) ; à la maison, l'adresse Wi-Fi du PC
    const joinUrl = `${(process.env.PUBLIC_URL || `http://${lanAddress()}:${PORT}`).replace(/\/+$/, '')}/play.html?code=${code}`;
    QRCode.toDataURL(joinUrl, { margin: 1, width: 240 }).then((qr) => {
      socket.emit("host:created", { code, listId, rounds: songs.length, joinUrl, qr });
    }).catch(() => socket.emit("host:created", { code, listId, rounds: songs.length, joinUrl }));
  });

  socket.on('host:leave', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id) return;
    clearTimers(room);
    socket.to(room.code).emit('room:closed');
    io.in(room.code).socketsLeave(room.code);
    rooms.delete(room.code);
    delete socket.data.code;
  });

  socket.on("player:join", ({ code, name } = {}, ack = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return ack({ ok: false, error: "Ce salon n'existe pas. Vérifiez le code." });
    if (room.state !== "lobby") return ack({ ok: false, error: "La partie a déjà commencé." });
    const clean = String(name || "").trim().slice(0, 16);
    if (!clean) return ack({ ok: false, error: "Entrez un pseudo." });
    // le jeton identifie le joueur même si son téléphone change de connexion (rechargement, Wi-Fi)
    const token = randomUUID();
    room.players.set(token, { token, socketId: socket.id, name: clean, score: 0, answer: null });
    socket.join(room.code);
    socket.data.code = room.code;
    socket.data.role = "player";
    socket.data.token = token;
    ack({ ok: true, code: room.code, token });
    broadcastPlayers(room);
  });

  // reprise d'une session joueur après rechargement ou coupure réseau
  socket.on("player:resume", ({ code, token } = {}, ack = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const p = room && typeof token === "string" ? room.players.get(token) : null;
    if (!p) return ack({ ok: false });
    p.socketId = socket.id;
    socket.join(room.code);
    socket.data.code = room.code;
    socket.data.role = "player";
    socket.data.token = token;
    ack({
      ok: true,
      name: p.name,
      state: room.state,
      answering: room.answering,
      answered: p.answer !== null,
      round: room.round + 1,
      total: room.songs.length,
      score: p.score,
    });
    broadcastPlayers(room);
  });

  socket.on("host:start", () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    if (room.players.size < 1) return;
    room.round = 0;
    startRound(room);
  });

  socket.on("player:answer", ({ text } = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.code);
    const p = room?.players.get(socket.data.token);
    if (!room || !p || !room.answering) return ack({ ok: false });
    p.answer = String(text || "").slice(0, 120);
    ack({ ok: true });
    io.to(room.hostId).emit("answers:count", [...room.players.values()].filter((x) => x.answer !== null).length);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    if (socket.data.role === "host") {
      clearTimers(room);
      io.to(room.code).emit("room:closed");
      rooms.delete(room.code);
    }
    // un joueur déconnecté garde sa place et son score : il peut reprendre avec player:resume
    const p = room.players.get(socket.data.token);
    if (p && p.socketId === socket.id) {
      p.socketId = null;
      broadcastPlayers(room);
    }
  });
});

const port = PORT;
http.listen(port, () => {
  console.log(`DtForget jeu local : http://localhost:${port}`);
  console.log(`Hôte (TV) : http://localhost:${port}/host.html`);
  console.log(`Joueurs (téléphone) : http://localhost:${port}/play.html`);
  console.log(`${CONTENT.length} extraits chargés`);
});

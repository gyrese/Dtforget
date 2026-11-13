// Test de fumée : un hôte, un joueur, une manche complète jusqu'à la révélation.
import { io } from "socket.io-client";

const URL = process.env.TEST_URL || "http://localhost:3000";
const host = io(URL);
const player = io(URL);
const log = (...a) => console.log(...a);
host.on("connect", () => host.emit("host:create"));

let code = null;
let answerText = null;

host.on("host:created", ({ code: c }) => {
  code = c;
  log("salon", code);
  player.emit("player:join", { code, name: "Testeur" }, (res) => {
    log("join", res);
    if (res.ok) {
      setTimeout(() => host.emit("host:start"), 300);
    }
  });
});

host.on("round:intro", (d) => log("intro", d.round, d.total, d.title));
host.on("round:clip", (c) => log("clip", c.audio, "cutAt", c.cutAt, "mots", c.words.length, "réponse", c.answerLength, "mots"));
player.on("answer:open", (d) => {
  log("answer:open", d.seconds, "s");
  // réponse volontairement fausse, pour vérifier le score sans révéler le mot
  player.emit("player:answer", { text: "mot faux" }, (r) => log("ack", r));
});
host.on("reveal", (d) => {
  log("reveal ranking", d.ranking.map((r) => `${r.name}:${r.points}`).join(" "));
  log("OK : manche complète");
  process.exit(0);
});
host.on("connect_error", (e) => { console.error("erreur", e.message); process.exit(1); });
setTimeout(() => { console.error("délai dépassé"); process.exit(1); }, 90000);

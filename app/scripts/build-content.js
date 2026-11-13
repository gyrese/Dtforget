// Construit app/data/content.json à partir des extraits validés du spike.
// Données sous droits (paroles, audio) : fichier local, ignoré par Git.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SPIKE_OUT = join(here, "..", "..", "spike", "out");
const SEP = "bs_roformer";
// Extrait de 45 s à 1 min : chant original 40 s avant la coupure, puis instrumental (cf. spike/relisten.py)
const PRE = 40.0;
const TAIL = 15.0;      // instrumental minimum après la coupure = temps de réponse
const MIN_TOTAL = 45.0;

const summary = JSON.parse(readFileSync(join(SPIKE_OUT, "batch_summary.json"), "utf-8"));
const clips = [];

for (const song of summary) {
  if (song.error || !song.gaps) continue;
  const words = JSON.parse(readFileSync(join(SPIKE_OUT, song.slug, `words_aligned_${SEP}.json`), "utf-8"));
  for (const g of song.gaps) {
    const file = `${song.slug}__${g.first}-${g.last}.wav`;
    if (!existsSync(join(SPIKE_OUT, "ECOUTE", file))) continue;
    const t0 = Math.max(0, g.cut_s - PRE); // début de l'extrait dans le morceau
    const t1 = Math.max(g.cut_s + TAIL, t0 + MIN_TOTAL); // fin de l'extrait
    const gapIdx = [];
    for (let i = g.first; i <= g.last; i++) gapIdx.push(i);
    const end = t1;
    const sel = words
      .map((w, i) => ({ ...w, i }))
      .filter((w) => w.start >= t0 - 0.2 && w.start <= end);
    clips.push({
      id: `${song.slug}__${g.first}-${g.last}`,
      film: song.film,
      title: song.title,
      audio: `/clips/${file}`,
      cutAt: +(g.cut_s - t0).toFixed(3),
      words: sel.map((w) => ({
        t: +(w.start - t0).toFixed(3),
        e: +(w.end - t0).toFixed(3),
        x: w.text,
        gap: gapIdx.includes(w.i),
      })),
      answer: gapIdx.map((i) => words[i].text).join(" "),
    });
  }
}

const outDir = join(here, "..", "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "content.json"), JSON.stringify(clips, null, 2), "utf-8");
console.log(`${clips.length} clips écrits dans app/data/content.json`);

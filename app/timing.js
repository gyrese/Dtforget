// Moments clés d'un extrait, partagés par le jeu et la bibliothèque de l'atelier.
// fin de l'instrumental dans le fichier : 5 s après le dernier mot à trouver
export const ANSWER_TAIL = 5;
export const lastGap = (clip) => clip.words.findLastIndex((w) => w.gap);
export function bedEnd(clip) {
  if (Number.isFinite(clip.bedEnd)) return clip.bedEnd;
  const i = lastGap(clip), gapEnd = Math.max(clip.cutAt, clip.words[i]?.e ?? 0);
  if (clip.revealAt != null) return Math.max(clip.cutAt, Math.min(gapEnd + ANSWER_TAIL, clip.revealAt - 1));
  // extrait d'avant la reprise chantée : la voix y revient juste après le trou (au mot suivant, 3 s au plus),
  // on s'arrête donc là ; pour avoir les 5 s d'instrumental, refaire l'extrait dans l'atelier
  const next = clip.words[i + 1]?.t ?? Infinity;
  return Math.max(clip.cutAt + 0.5, gapEnd + 0.05, Math.min(next - 0.05, gapEnd + 3));
}

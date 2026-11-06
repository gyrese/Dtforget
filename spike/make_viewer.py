"""Génère out/viewer/index.html : extrait coupé + paroles synchronisées, pour écoute locale.

Les paroles sont écrites dans out/viewer/data.js (fichier local, ignoré par git), jamais dans le chat.
Ouvrir ensuite out/viewer/index.html dans le navigateur.
"""
import json
import shutil

from common import OUT, ROOT, dump

SEP = "bs_roformer"


def lines_of(words):
    out, cur = [], []
    for w in words:
        if cur and (w["start"] - cur[-1]["end"] > 0.6 or cur[-1]["text"].rstrip()[-1:] in ".?!"):
            out.append(cur)
            cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


def main() -> None:
    viewer = OUT / "viewer"
    (viewer / "audio").mkdir(parents=True, exist_ok=True)
    summary = json.loads((OUT / "batch_summary.json").read_text(encoding="utf-8"))
    items = []
    for r in summary:
        if "error" in r or not r.get("gaps"):
            continue
        d = OUT / r["slug"]
        words = json.loads((d / f"words_aligned_{SEP}.json").read_text(encoding="utf-8"))
        for g in r["gaps"]:
            src = OUT / "ECOUTE" / f"{r['slug']}__{g['first']}-{g['last']}.wav"
            if not src.exists():
                continue
            name = f"{r['slug']}__{g['first']}-{g['last']}.wav"
            shutil.copy(src, viewer / "audio" / name)
            t0 = g["cut_s"] - 8.0  # l'extrait commence 8 s avant la coupure
            gap_ids = set(range(g["first"], g["last"] + 1))
            # paroles de l'extrait : de t0 à la fin du trou + 3 s
            end = words[g["last"]]["end"] + 3
            sel = [(i, w) for i, w in enumerate(words) if t0 <= w["start"] <= end]
            lines = []
            for ln in lines_of([dict(w, _i=i) for i, w in sel]):
                lines.append([{"t": round(w["start"] - t0, 2), "e": round(w["end"] - t0, 2),
                               "x": w["text"], "gap": w["_i"] in gap_ids} for w in ln])
            items.append({"film": r["film"], "title": r["title"], "audio": f"audio/{name}",
                          "cut": round(g["cut_s"] - t0, 2), "lines": lines,
                          "gap_words": g["words"], "onset_err_ms": g["onset_err_ms"],
                          "margin_ms": g["margin_cut_to_voice_ms"], "voice_db": g["voice_at_cut_db"]})
    (viewer / "data.js").write_text("window.DATA = " + json.dumps(items, ensure_ascii=False) + ";", encoding="utf-8")
    (viewer / "index.html").write_text(HTML, encoding="utf-8")
    print(f"{len(items)} extraits → {viewer / 'index.html'}")


HTML = """<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Extraits karaoké</title>
<style>
:root{--bg:#0f1220;--fg:#f4f4f8;--dim:#6b7080;--hi:#ffd447;--gap:#4fd1c5;--card:#181c2e}
body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);padding:16px}
h1{font-size:18px;margin:0 0 12px}
select,button{font:inherit;background:var(--card);color:var(--fg);border:1px solid #2a2f48;border-radius:8px;padding:8px 12px}
#stage{margin-top:16px;background:var(--card);border-radius:14px;padding:20px;min-height:200px}
.line{font-size:clamp(18px,3.4vw,28px);line-height:1.5;color:var(--dim);margin:4px 0}
.line.active{color:var(--fg)}
.w{transition:color .15s}
.w.on{color:var(--hi)}
.w.gap{color:var(--gap)}
.blank{display:inline-block;border-bottom:3px solid var(--gap);min-width:2.2em;margin:0 .15em}
#meta{font-size:13px;color:var(--dim);margin-top:10px}
audio{width:100%;margin-top:12px}
</style></head><body>
<h1>Extrait coupé + paroles synchronisées</h1>
<select id="pick"></select>
<div id="stage"><div id="lines"></div></div>
<audio id="a" controls></audio>
<div id="meta"></div>
<script src="data.js"></script>
<script>
const pick=document.getElementById('pick'),linesEl=document.getElementById('lines'),a=document.getElementById('a'),meta=document.getElementById('meta');
let cur=null;
DATA.forEach((d,i)=>{const o=document.createElement('option');o.value=i;o.textContent=d.film+' — '+d.title;pick.appendChild(o);});
function render(d){
  cur=d; linesEl.innerHTML='';
  d.lines.forEach(ln=>{
    const L=document.createElement('div');L.className='line';
    ln.forEach(w=>{
      const s=document.createElement('span');s.className='w'+(w.gap?' gap':'');
      s.dataset.t=w.t; s.dataset.e=w.e; s.dataset.gap=w.gap?1:0;
      s.textContent=w.x+' ';
      L.appendChild(s);
    });
    linesEl.appendChild(L);
  });
  a.src=d.audio;
  meta.textContent='Coupure à '+d.cut.toFixed(2)+' s · '+d.gap_words+' mots cachés · décalage début '+d.onset_err_ms+' ms · marge '+d.margin_ms+' ms · voix à la coupure '+d.voice_db+' dB';
}
function tick(){
  if(!cur) return; const t=a.currentTime;
  const cutOn = t>=cur.cut;
  document.querySelectorAll('.w').forEach(s=>{
    const gap=s.dataset.gap==='1';
    const t0=+s.dataset.t, t1=+s.dataset.e;
    const on=t>=t0&&t<t1;
    s.classList.toggle('on',on);
    if(gap){
      if(cutOn){ s.textContent=s.dataset.hidden||(s.dataset.hidden='_'.repeat(Math.max(2,s.textContent.trim().length))+' '); }
      else { if(s.dataset.orig){s.textContent=s.dataset.orig+' ';} }
    }
  });
}
document.querySelectorAll('.w').forEach(s=>s.dataset.orig=s.textContent.trim());
pick.onchange=()=>render(DATA[pick.value]);
a.ontimeupdate=tick;
if(DATA.length) render(DATA[0]);
</script></body></html>"""


if __name__ == "__main__":
    main()

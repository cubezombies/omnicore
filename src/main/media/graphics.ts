// Original explanatory graphics (stat, comparison, steps, quote, source, title, sources roll) as
// self-contained HTML, rasterised to 1080×1920 PNG. Every graphic carries a visible
// "Graphic · AI, Actually" mark so it is never mistaken for a photo, screenshot or real document.

export type GraphicSpec =
  | { kind: 'title'; kicker: string; text: string }
  | { kind: 'stat'; value: string; label: string; attribution: string }
  | { kind: 'compare'; bars: { label: string; value: number; display: string }[]; caption: string; attribution: string }
  | { kind: 'steps'; title: string; steps: string[] }
  | { kind: 'quote'; text: string; attribution: string }
  | { kind: 'source'; publisher: string; title: string; sourceKind: string; line: string }
  | { kind: 'sources'; brand: string; publishers: string[] }
  | { kind: 'timeline'; title: string; events: { when: string; what: string }[]; attribution: string };

export const GRAPHIC_MARK = 'Graphic · AI, Actually';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Accent per scene so consecutive graphics don't look identical. */
const ACCENTS = ['#5eead4', '#fbbf24', '#93c5fd', '#f9a8d4', '#86efac', '#fca5a5'];

/** How many items a graphic reveals one at a time (1 = shown all at once). */
export function revealSteps(spec: GraphicSpec): number {
  if (spec.kind === 'steps') return Math.min(4, spec.steps.length);
  if (spec.kind === 'compare') return Math.min(4, spec.bars.length);
  if (spec.kind === 'timeline') return Math.min(5, spec.events.length);
  return 1;
}

const hide = (i: number, reveal: number) => (i >= reveal ? ' style="visibility:hidden"' : '');

function body(spec: GraphicSpec, accent: string, reveal = 99): string {
  switch (spec.kind) {
    case 'title':
      return `<div class="kicker">${esc(clip(spec.kicker, 60))}</div><div class="title">${esc(clip(spec.text, 110))}</div><div class="rule"></div>`;
    case 'stat':
      return `<div class="kicker">The number</div><div class="stat${spec.value.length > 5 ? ' long' : ''}">${esc(clip(spec.value, 14))}</div><div class="label">${esc(clip(spec.label, 120))}</div><div class="attr">According to ${esc(clip(spec.attribution, 60))}</div>`;
    case 'compare': {
      const max = Math.max(...spec.bars.map((b) => b.value), 1e-9);
      const bars = spec.bars
        .slice(0, 4)
        .map(
          (b, i) =>
            `<div class="bar-row"${hide(i, reveal)}><div class="bar-label">${esc(clip(b.label, 28))}</div><div class="bar-track"><div class="bar" style="width:${Math.max(4, (b.value / max) * 100).toFixed(1)}%;background:${i === spec.bars.length - 1 ? accent : '#475569'}"></div></div><div class="bar-val">${esc(clip(b.display, 10))}</div></div>`
        )
        .join('');
      return `<div class="kicker">By the numbers</div><div class="label">${esc(clip(spec.caption, 110))}</div><div class="bars">${bars}</div><div class="attr">Figures as stated by ${esc(clip(spec.attribution, 60))} · illustrative scale</div>`;
    }
    case 'steps':
      return `<div class="kicker">How it works</div><div class="label">${esc(clip(spec.title, 80))}</div><ol class="steps">${spec.steps
        .slice(0, 4)
        .map((s, i) => `<li${hide(i, reveal)}><span class="num">${i + 1}</span><span>${esc(clip(s, 70))}</span></li>`)
        .join('')}</ol>`;
    case 'quote':
      // Narration is written in our own words, so this is a credited key point, never a verbatim quotation.
      return `<div class="kicker">Key point</div><div class="point"><div class="quote${spec.text.length > 120 ? ' dense' : ''}">${esc(clip(spec.text, 170))}</div></div><div class="attr">Source: ${esc(clip(spec.attribution, 60))}</div>`;
    case 'source':
      return `<div class="kicker">From the source</div><div class="src-card"><div class="src-pub">${esc(clip(spec.publisher, 60))} · ${esc(spec.sourceKind)}</div><div class="src-title">${esc(clip(spec.title, 90))}</div></div><div class="label dense">${esc(clip(spec.line, 120))}</div>`;
    case 'timeline':
      return `<div class="kicker">Timeline</div><div class="label">${esc(clip(spec.title, 80))}</div><ol class="timeline">${spec.events
        .slice(0, 5)
        .map((e, i) => `<li${hide(i, reveal)}><span class="when">${esc(clip(e.when, 12))}</span><span class="what">${esc(clip(e.what, 70))}</span></li>`)
        .join('')}</ol><div class="attr">Dates as stated by ${esc(clip(spec.attribution, 60))}</div>`;
    case 'sources':
      return `<div class="kicker">Sources in the description</div><ul class="pubs">${[...new Set(spec.publishers)]
        .slice(0, 5)
        .map((p) => `<li>${esc(clip(p, 34))}</li>`)
        .join('')}</ul><div class="title small">Follow ${esc(spec.brand)}</div>`;
  }
}

/** Self-contained HTML (no scripts, no network) for one graphic. */
export function graphicHtml(spec: GraphicSpec, sceneIndex = 0, reveal = 99): string {
  const accent = ACCENTS[sceneIndex % ACCENTS.length];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1920px;overflow:hidden}
body{font-family:"Segoe UI",system-ui,sans-serif;color:#f8fafc;background:radial-gradient(1200px 900px at 20% 10%,${accent}33,transparent 60%),linear-gradient(160deg,#0f172a,#020617 70%)}
.wrap{position:absolute;left:90px;right:90px;top:180px;height:880px;overflow:hidden;display:flex;flex-direction:column;justify-content:safe center;gap:30px}
.kicker{font-size:40px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:${accent}}
.title{font-size:92px;font-weight:800;line-height:1.08}
.title.small{font-size:64px;margin-top:20px}
.rule{width:180px;height:12px;border-radius:6px;background:${accent}}
.stat.long{font-size:170px}
.stat{font-size:250px;font-weight:800;line-height:1;color:${accent};letter-spacing:-6px}
.label{font-size:56px;font-weight:600;line-height:1.25;color:#e2e8f0}
.attr{font-size:36px;color:#94a3b8}
.bars{display:flex;flex-direction:column;gap:34px;margin-top:10px}
.bar-row{display:grid;grid-template-columns:250px 1fr 170px;align-items:center;gap:24px}
.bar-label{font-size:38px;color:#cbd5e1}
.bar-track{height:64px;background:#1e293b;border-radius:14px;overflow:hidden}
.bar{height:100%;border-radius:14px}
.bar-val{font-size:52px;font-weight:800;text-align:right}
.steps{list-style:none;display:flex;flex-direction:column;gap:30px}
.steps li{display:flex;gap:30px;align-items:center;font-size:50px;font-weight:600;line-height:1.2;background:#0f172acc;border:2px solid #334155;border-radius:24px;padding:26px 30px}
.num{flex:none;width:84px;height:84px;border-radius:50%;background:${accent};color:#020617;font-weight:800;display:flex;align-items:center;justify-content:center}
.point{border-left:16px solid ${accent};padding-left:40px}
.quote{font-size:60px;font-weight:600;line-height:1.28}
.quote.dense,.label.dense{font-size:48px}
.src-card{border:3px solid #334155;border-left:16px solid ${accent};border-radius:22px;padding:40px;background:#0b1222}
.src-pub{font-size:36px;color:#94a3b8;margin-bottom:18px}
.src-title{font-size:48px;font-weight:700;line-height:1.2}
.pubs{list-style:none;display:flex;flex-direction:column;gap:22px}
.pubs li{font-size:46px;font-weight:600;padding-left:40px;border-left:10px solid ${accent}}
.timeline{list-style:none;position:relative;display:flex;flex-direction:column;gap:30px;padding-left:46px;border-left:6px solid ${accent}55}
.timeline li{position:relative;display:flex;flex-direction:column;gap:6px}
.timeline li::before{content:'';position:absolute;left:-62px;top:10px;width:26px;height:26px;border-radius:50%;background:${accent}}
.when{font-size:44px;font-weight:800;color:${accent}}
.what{font-size:44px;font-weight:600;line-height:1.2}
.mark{position:absolute;right:60px;top:70px;font-size:30px;color:#94a3b8;border:2px solid #334155;border-radius:999px;padding:10px 26px}
</style></head><body><div class="mark">${GRAPHIC_MARK}</div><div class="wrap">${body(spec, accent, reveal)}</div></body></html>`;
}

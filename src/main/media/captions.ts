// Word-timed captions → ASS subtitle file burned in by FFmpeg (libass).

export interface WordTiming {
  text: string;
  start: number; // seconds, relative to the scene start
  end: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface SceneTiming {
  offset: number; // seconds from video start
  duration: number;
  words: WordTiming[];
}

const MAX_WORDS = 3;
const MAX_CHARS = 20;

/** Group words into short punchy cues (≤3 words / ≤20 chars), breaking at punctuation. */
export function buildCues(scenes: SceneTiming[]): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const sc of scenes) {
    let group: WordTiming[] = [];
    const flush = () => {
      if (!group.length) return;
      const start = sc.offset + group[0].start;
      const end = Math.min(sc.offset + group[group.length - 1].end, sc.offset + sc.duration);
      // A doubled stop in a script ("etc..") is shown once; a real ellipsis ("...") is kept.
      cues.push({ start, end: Math.max(end, start + 0.2), text: group.map((w) => w.text).join(' ').replace(/(?<!\.)\.\.(?!\.)/g, '.') });
      group = [];
    };
    for (const w of sc.words) {
      const nextLen = [...group, w].map((x) => x.text).join(' ').length;
      if (group.length && (group.length >= MAX_WORDS || nextLen > MAX_CHARS)) flush();
      group.push(w);
      if (/[.,!?;:]$/.test(w.text)) flush();
    }
    flush();
  }
  // Remove overlaps so only one cue is on screen at a time.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }
  return cues.filter((c) => c.end - c.start >= 0.05);
}

export const assTime = (sec: number): string => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/** Escape text for an ASS Dialogue line (braces start override blocks, backslash escapes). */
export const assEscape = (t: string): string =>
  t.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, ' ');

export function assHeader(styles: string[], w = 1080, h = 1920): string {
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ].join('\n');
}

export function buildAss(cues: CaptionCue[], labels: CaptionCue[] = []): string {
  const style = 'Style: Cap,Segoe UI,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,8,3,2,90,90,620,1';
  // Small boxed label, top-left (e.g. "AI-generated illustration").
  const label = 'Style: Lbl,Segoe UI,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,1,0,3,10,0,7,60,60,90,1';
  const lines = [
    ...labels.map((l) => `Dialogue: 1,${assTime(l.start)},${assTime(l.end)},Lbl,,0,0,0,,${assEscape(l.text)}`),
    ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,{\\fad(60,0)}${assEscape(c.text.toUpperCase())}`)
  ];
  return `${assHeader([style, label])}\n${lines.join('\n')}\n`;
}

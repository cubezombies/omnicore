// Builds the single FFmpeg command that assembles scenes, narration, music and captions.

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const FPS = 30;
/** Silence after each scene's narration so cuts don't feel rushed. */
export const SCENE_PAD_SEC = 0.35;
/** Music is normalised to this loudness before mixing (narration is -16 LUFS). */
export const MUSIC_LUFS = -30;
/** The settings default; other values scale the normalised music relative to it. */
export const DEFAULT_MUSIC_VOLUME = 0.12;
export const MUSIC_FADE_IN_SEC = 1.2;
export const MUSIC_FADE_OUT_SEC = 1.8;
export const END_FADE_SEC = 0.25;
const LIMIT = 0.85;
/** Dissolve between the frames of a build-up animation. */
export const BUILD_FADE_SEC = 0.2;

export type Motion = 'in' | 'out' | 'left' | 'right' | 'still';
export type Transition = 'fade' | 'smoothleft' | 'smoothup' | 'slideleft' | 'circleopen';
/** Cross-transition length; each scene's picture runs this much longer so cuts stay on the narration boundaries. */
export const XFADE_SEC = 0.3;

export interface RenderScene {
  image: string; // path relative to cwd
  audio: string; // path relative to cwd
  durationSec: number; // frame-aligned scene duration (narration + pad)
  /** Camera move on the still (default: alternate push-in / pull-out). */
  motion?: Motion;
  /** Transition INTO this scene from the previous one (ignored for the first scene; default: hard cut). */
  transition?: Transition;
  /** Build-up animation: these images are shown in turn across the scene (each one reveals a little more). */
  frames?: string[];
}

export interface RenderPlan {
  scenes: RenderScene[];
  captions: string; // ASS file relative to cwd (relative avoids filter-path escaping on Windows)
  output: string;
  music?: { path: string; volume: number };
  /** One-shot effect mixed in at each listed time (e.g. a whoosh at scene cuts). */
  sfx?: { path: string; volume: number; atSec: number[] };
  /** More accents (intro riser, outro accent), each its own file, volume and times. */
  cues?: { path: string; volume: number; atSec: number[] }[];
}

/** Times (s) at which a transition effect starts: slightly before each cut so it peaks on the cut. */
export const transitionTimes = (p: Pick<RenderPlan, 'scenes'>, lead = 0.3): number[] => {
  const out: number[] = [];
  let t = 0;
  p.scenes.slice(0, -1).forEach((s) => {
    t += s.durationSec;
    out.push(Math.max(0, t - lead));
  });
  return out;
};

/** Round to whole frames so audio padding and video length agree exactly. */
export const frameAlign = (sec: number): number => Math.max(1, Math.round(sec * FPS)) / FPS;

export const totalDuration = (p: RenderPlan): number => p.scenes.reduce((s, x) => s + x.durationSec, 0);

export function buildRenderArgs(p: RenderPlan): string[] {
  if (!p.scenes.length) throw new Error('Nothing to render: no scenes.');
  const n = p.scenes.length;
  const args: string[] = [];
  // Inputs: every scene's image(s), then every scene's narration, then music and the transition effect.
  const sceneInputs: number[][] = [];
  let next = 0;
  for (const s of p.scenes) {
    const imgs = s.frames?.length ? s.frames : [s.image];
    sceneInputs.push(imgs.map(() => next++));
    for (const img of imgs) args.push('-i', img);
  }
  const audioBase = next;
  for (const s of p.scenes) args.push('-i', s.audio);
  const musicInput = audioBase + n;
  if (p.music) args.push('-stream_loop', '-1', '-i', p.music.path);
  // Every accent group (transitions, intro, outro) is one input; each group's times are delayed copies of it.
  const groups = [...(p.sfx ? [p.sfx] : []), ...(p.cues ?? [])].map((g) => ({ ...g, atSec: g.atSec.filter((t) => t >= 0) })).filter((g) => g.atSec.length);
  for (const g of groups) args.push('-i', g.path);
  const sfxInput = musicInput + (p.music ? 1 : 0);

  const W2 = Math.round(VIDEO_W * 1.25);
  const H2 = Math.round(VIDEO_H * 1.25);
  const f: string[] = [];
  const xf = p.scenes.some((s, i) => i > 0 && s.transition);
  p.scenes.forEach((s, i) => {
    // With transitions, every scene but the last runs XFADE_SEC longer and overlaps the next one.
    const extra = xf && i < n - 1 ? XFADE_SEC : 0;
    const frames = Math.round((s.durationSec + extra) * FPS);
    const motion: Motion = s.motion ?? (i % 2 === 0 ? 'in' : 'out');
    const cx = `iw/2-(iw/zoom/2)`;
    const cy = `ih/2-(ih/zoom/2)`;
    const [zoom, x] =
      motion === 'in'
        ? [`min(1+0.12*on/${frames},1.12)`, cx]
        : motion === 'out'
          ? [`max(1.12-0.12*on/${frames},1)`, cx]
          : motion === 'left'
            ? ['1.12', `(iw-iw/zoom)*(1-on/${frames})`]
            : motion === 'right'
              ? ['1.12', `(iw-iw/zoom)*on/${frames}`]
              : [`min(1+0.03*on/${frames},1.03)`, cx];
    const ins = sceneInputs[i];
    if (ins.length === 1) {
      f.push(
        `[${ins[0]}:v]scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},setsar=1,` +
          `zoompan=z='${zoom}':x='${x}':y='${cy}':d=${frames}:s=${VIDEO_W}x${VIDEO_H}:fps=${FPS},` +
          `trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
      );
    } else {
      // Build-up: each frame holds for an equal share of the scene and dissolves into the next.
      const k = ins.length;
      const base = Math.floor(frames / k);
      const seg = (j: number) => (j < k - 1 ? base : frames - base * (k - 1));
      const fade = Math.round(BUILD_FADE_SEC * FPS);
      ins.forEach((input, j) => {
        const len = seg(j) + (j < k - 1 ? fade : 0);
        f.push(`[${input}:v]scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase,crop=${VIDEO_W}:${VIDEO_H},setsar=1,loop=loop=${len}:size=1:start=0,fps=${FPS},trim=end_frame=${len},setpts=PTS-STARTPTS,format=yuv420p[v${i}f${j}]`);
      });
      let prev = `v${i}f0`;
      let off = 0;
      for (let j = 1; j < k; j++) {
        off += seg(j - 1) / FPS;
        const out = j === k - 1 ? `v${i}` : `v${i}b${j}`;
        f.push(`[${prev}][v${i}f${j}]xfade=transition=fade:duration=${BUILD_FADE_SEC}:offset=${off.toFixed(4)}[${out}]`);
        prev = out;
      }
    }
    f.push(
      `[${audioBase + i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `apad=whole_dur=${s.durationSec.toFixed(4)},atrim=duration=${s.durationSec.toFixed(4)}[a${i}]`
    );
  });
  if (xf && n > 1) {
    let prev = 'v0';
    let offset = 0;
    for (let i = 1; i < n; i++) {
      offset += p.scenes[i - 1].durationSec;
      const out = i === n - 1 ? 'vc' : `x${i}`;
      f.push(`[${prev}][v${i}]xfade=transition=${p.scenes[i].transition ?? 'fade'}:duration=${XFADE_SEC}:offset=${offset.toFixed(4)}[${out}]`);
      prev = out;
    }
    f.push(`${p.scenes.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[ac]`);
  } else {
    f.push(`${p.scenes.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[vc][ac]`);
  }
  f.push(`[vc]ass=${p.captions},format=yuv420p[vout]`);
  f.push(`[ac]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[narr]`);
  const total = totalDuration(p);
  if (p.music) {
    // Every track is brought to the same loudness first (about 14 LU under the narration), so the volume setting means
    // the same thing for every song; then fade in and out, and duck under the voice.
    const gain = p.music.volume / DEFAULT_MUSIC_VOLUME;
    const fadeOut = Math.max(0, total - MUSIC_FADE_OUT_SEC);
    f.push(
      `[${musicInput}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,loudnorm=I=${MUSIC_LUFS}:TP=-6:LRA=7,aresample=48000,` +
        `volume=${gain.toFixed(3)},afade=t=in:st=0:d=${MUSIC_FADE_IN_SEC},afade=t=out:st=${fadeOut.toFixed(3)}:d=${MUSIC_FADE_OUT_SEC}[mus]`
    );
    f.push(`[narr]asplit=2[n1][n2]`);
    f.push(`[mus][n1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`);
    f.push(`[n2][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[bed]`);
  } else {
    f.push(`[narr]anull[bed]`);
  }
  if (groups.length) {
    const labels: string[] = [];
    groups.forEach((g, gi) => {
      const k = g.atSec.length;
      const names = g.atSec.map((_, i) => `[sx${gi}_${i}]`);
      f.push(`[${sfxInput + gi}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${g.volume.toFixed(3)}` + (k > 1 ? `,asplit=${k}${names.join('')}` : names[0]));
      g.atSec.forEach((t, i) => {
        const ms = Math.round(t * 1000);
        f.push(`${names[i]}adelay=${ms}|${ms}[sd${gi}_${i}]`);
        labels.push(`[sd${gi}_${i}]`);
      });
    });
    f.push(`[bed]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0[amix]`);
  } else {
    f.push(`[bed]anull[amix]`);
  }
  // Safety limiter (no clipping, about -1.4 dBFS ceiling) and a short fade so the video never ends on a cut.
  f.push(`[amix]alimiter=limit=${LIMIT}:level=false,afade=t=out:st=${Math.max(0, total - END_FADE_SEC).toFixed(3)}:d=${END_FADE_SEC}[aout]`);

  args.push(
    '-filter_complex', f.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    '-t', total.toFixed(3),
    p.output
  );
  return args;
}

// Builds the single FFmpeg command that assembles scenes, narration, music and captions.

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const FPS = 30;
/** Silence after each scene's narration so cuts don't feel rushed. */
export const SCENE_PAD_SEC = 0.35;

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
}

export interface RenderPlan {
  scenes: RenderScene[];
  captions: string; // ASS file relative to cwd (relative avoids filter-path escaping on Windows)
  output: string;
  music?: { path: string; volume: number };
  /** One-shot effect mixed in at each listed time (e.g. a whoosh at scene cuts). */
  sfx?: { path: string; volume: number; atSec: number[] };
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
  for (const s of p.scenes) args.push('-i', s.image);
  for (const s of p.scenes) args.push('-i', s.audio);
  if (p.music) args.push('-stream_loop', '-1', '-i', p.music.path);
  const sfxTimes = p.sfx?.atSec.filter((t) => t >= 0) ?? [];
  if (p.sfx && sfxTimes.length) args.push('-i', p.sfx.path);
  const sfxInput = 2 * n + (p.music ? 1 : 0);

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
    f.push(
      `[${i}:v]scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},setsar=1,` +
        `zoompan=z='${zoom}':x='${x}':y='${cy}':d=${frames}:s=${VIDEO_W}x${VIDEO_H}:fps=${FPS},` +
        `trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
    );
    f.push(
      `[${n + i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
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
  if (p.music) {
    f.push(`[${2 * n}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${p.music.volume.toFixed(3)}[mus]`);
    f.push(`[narr]asplit=2[n1][n2]`);
    f.push(`[mus][n1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`);
    f.push(`[n2][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[bed]`);
  } else {
    f.push(`[narr]anull[bed]`);
  }
  if (p.sfx && sfxTimes.length) {
    const k = sfxTimes.length;
    f.push(
      `[${sfxInput}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${p.sfx.volume.toFixed(3)}` +
        (k > 1 ? `,asplit=${k}${sfxTimes.map((_, i) => `[sx${i}]`).join('')}` : '[sx0]')
    );
    sfxTimes.forEach((t, i) => {
      const ms = Math.round(t * 1000);
      f.push(`[sx${i}]adelay=${ms}|${ms}[sd${i}]`);
    });
    f.push(`[bed]${sfxTimes.map((_, i) => `[sd${i}]`).join('')}amix=inputs=${k + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else {
    f.push(`[bed]anull[aout]`);
  }

  const total = totalDuration(p);
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

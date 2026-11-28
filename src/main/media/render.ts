// Builds the single FFmpeg command that assembles scenes, narration, music and captions.

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const FPS = 30;
/** Silence after each scene's narration so cuts don't feel rushed. */
export const SCENE_PAD_SEC = 0.35;
export { MUSIC_FADE_IN_SEC, MUSIC_FADE_OUT_SEC } from '../../shared/audioMix';
import { MUSIC_FADE_IN_SEC, MUSIC_FADE_OUT_SEC } from '../../shared/audioMix';
export const END_FADE_SEC = 0.25;
/** Final safety limiter ceiling, linear (-1.5 dBFS). QA requires true peak <= -1 dBTP. */
const LIMIT = 0.841;
/** Narration safety limiter (-2 dBFS) after per-scene loudness matching. */
const NARRATION_LIMIT = 0.794;
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
  /** Narration starts this long into the scene (the music-only intro on the first scene). */
  audioDelaySec?: number;
}

export interface RenderPlan {
  scenes: RenderScene[];
  captions: string; // ASS file relative to cwd (relative avoids filter-path escaping on Windows)
  output: string;
  /** The soundtrack. Required: there is no render without music. */
  audio: RenderAudio;
}

/**
 * Every level is a measured gain (dB) that brings a file to its loudness target, not a volume percentage.
 * The music is multiplied by a precomputed ducking envelope (see audio/mix.ts), so ducking is exact and testable.
 */
export interface RenderAudio {
  /** Gain per scene narration clip so every scene sits at the narration target. */
  narrationGainDb: number[];
  music: { path: string; gainDb: number; envelope: string };
  /** Contextual effects approved for this production (usually none): file, gain and start times. */
  sfx: { role: 'contextual'; path: string; gainDb: number; atSec: number[] }[];
  /** One gain on every bus (dB) that brings the finished mix to the delivery loudness (set by the measuring pre-pass). */
  masterGainDb?: number;
  /** Stems written next to the video (exactly what went into the mix, before the final limiter), for QA. */
  stems: { narration: string; music: string; musicDry: string; sfx: string };
}


/** Round to whole frames so audio padding and video length agree exactly. */
export const frameAlign = (sec: number): number => Math.max(1, Math.round(sec * FPS)) / FPS;

export const totalDuration = (p: RenderPlan): number => p.scenes.reduce((s, x) => s + x.durationSec, 0);

export function buildRenderArgs(p: RenderPlan): string[] {
  if (!p.scenes.length) throw new Error('Nothing to render: no scenes.');
  const n = p.scenes.length;
  const args: string[] = [];
  // Inputs: every scene's image(s), then every scene's narration, then the soundtrack inputs.
  const sceneInputs: number[][] = [];
  let next = 0;
  for (const s of p.scenes) {
    const imgs = s.frames?.length ? s.frames : [s.image];
    sceneInputs.push(imgs.map(() => next++));
    for (const img of imgs) args.push('-i', img);
  }
  const sound = soundtrackGraph(p, next, true);
  args.push(...sound.inputs);

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
  } else {
    f.push(`${p.scenes.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vc]`);
  }
  f.push(`[vc]ass=${p.captions},format=yuv420p[vout]`);
  f.push(...sound.filters);
  const total = totalDuration(p);
  const t3 = total.toFixed(3);
  const a = p.audio;

  args.push(
    '-filter_complex', f.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    '-t', t3,
    p.output
  );
  for (const [label, file] of [['narrS', a.stems.narration], ['musS', a.stems.music], ['musdryS', a.stems.musicDry], ['sfxS', a.stems.sfx]] as const) {
    args.push('-map', `[${label}]`, '-c:a', 'flac', '-ar', '48000', '-t', t3, file);
  }
  return args;
}


/**
 * The soundtrack part of the render graph (shared by the render and the loudness pre-pass): narration matched scene
 * by scene, music at its measured gain with fades and the ducking envelope, effects at their cue times, one master
 * gain on every bus (final loudness normalisation), the safety limiter and the end fade. Narration inputs start at
 * index `base`. With stems, each bus is also split out for the stem files.
 */
export function soundtrackGraph(p: RenderPlan, base: number, stems: boolean): { inputs: string[]; filters: string[] } {
  const a = p.audio;
  const n = p.scenes.length;
  if (!a?.music?.path) throw new Error('No soundtrack in the render plan: every video must carry approved music.');
  if (a.narrationGainDb.length !== n) throw new Error('Render plan has no loudness gain for every scene.');
  const master = a.masterGainDb ?? 0;
  const inputs: string[] = [];
  for (const s of p.scenes) inputs.push('-i', s.audio);
  const musicInput = base + n;
  inputs.push('-stream_loop', '-1', '-i', a.music.path);
  const envInput = musicInput + 1;
  inputs.push('-i', a.music.envelope);
  // Every effect group (transitions, intro, outro) is one input; each group's times are delayed copies of it.
  const groups = a.sfx.map((g) => ({ ...g, atSec: g.atSec.filter((t) => t >= 0) })).filter((g) => g.atSec.length);
  for (const g of groups) inputs.push('-i', g.path);
  const sfxInput = envInput + 1;
  const total = totalDuration(p);
  const t3 = total.toFixed(3);
  const split = (label: string) => (stems ? `asplit=2[${label}][${label}S]` : `anull[${label}]`);
  const f: string[] = [];
  p.scenes.forEach((s, i) => {
    f.push(
      `[${base + i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${(a.narrationGainDb[i] + master).toFixed(2)}dB,${s.audioDelaySec ? `adelay=${Math.round(s.audioDelaySec * 1000)}:all=1,` : ''}apad=whole_dur=${s.durationSec.toFixed(4)},atrim=duration=${s.durationSec.toFixed(4)}[a${i}]`
    );
  });
  f.push(`${p.scenes.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[ac]`);
  // Narration: each scene already matched to the target loudness; a gentle limiter catches stray peaks.
  f.push(`[ac]alimiter=limit=${NARRATION_LIMIT}:attack=3:release=40:level=false,aresample=48000,${split('narr')}`);
  // Music: measured gain to the profile's open level, fades, then the ducking envelope.
  const fadeOut = Math.max(0, total - MUSIC_FADE_OUT_SEC);
  f.push(
    `[${musicInput}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${t3},volume=${(a.music.gainDb + master).toFixed(2)}dB,` +
      `afade=t=in:st=0:d=${MUSIC_FADE_IN_SEC},afade=t=out:st=${fadeOut.toFixed(3)}:d=${MUSIC_FADE_OUT_SEC},${stems ? 'asplit=2[musdry][musdryS]' : 'anull[musdry]'}`
  );
  // The envelope is a gain, so its channel is copied (a power-preserving mono→stereo upmix would lower it 3 dB).
  f.push(`[${envInput}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp,apad=whole_dur=${t3},atrim=duration=${t3}[env]`);
  f.push(`[musdry][env]amultiply,${split('mus')}`);
  // Effects: measured gain to each role's peak level, placed at their cue times.
  const labels: string[] = [];
  groups.forEach((g, gi) => {
    const k = g.atSec.length;
    const names = g.atSec.map((_, i) => `[sx${gi}_${i}]`);
    f.push(`[${sfxInput + gi}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${(g.gainDb + master).toFixed(2)}dB` + (k > 1 ? `,asplit=${k}${names.join('')}` : names[0]));
    g.atSec.forEach((t, i) => {
      const ms = Math.round(t * 1000);
      f.push(`${names[i]}adelay=${ms}|${ms}[sd${gi}_${i}]`);
      labels.push(`[sd${gi}_${i}]`);
    });
  });
  f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${t3}[sfxbase]`);
  f.push(`[sfxbase]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0,${split('sfx')}`);
  f.push(`[narr][mus][sfx]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[amix]`);
  // Safety limiter (about -1.5 dBFS ceiling) and a short fade so the video never ends on a cut.
  f.push(`[amix]alimiter=limit=${LIMIT}:attack=2:release=50:level=false,afade=t=out:st=${Math.max(0, total - END_FADE_SEC).toFixed(3)}:d=${END_FADE_SEC}[aout]`);
  return { inputs, filters: f };
}

/** Audio-only pass of the exact soundtrack graph, measured with EBU R128 (for the master gain). Output: stderr summary. */
export function buildMixMeasureArgs(p: RenderPlan): string[] {
  const g = soundtrackGraph(p, 0, false);
  return [...g.inputs, '-filter_complex', [...g.filters, '[aout]ebur128=peak=true[m]'].join(';'), '-map', '[m]', '-t', totalDuration(p).toFixed(3), '-f', 'null', '-'];
}

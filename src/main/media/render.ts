// Builds the single FFmpeg command that assembles scenes, narration, music and captions.

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const FPS = 30;
/** Silence after each scene's narration so cuts don't feel rushed. */
export const SCENE_PAD_SEC = 0.35;

export interface RenderScene {
  image: string; // path relative to cwd
  audio: string; // path relative to cwd
  durationSec: number; // frame-aligned scene duration (narration + pad)
}

export interface RenderPlan {
  scenes: RenderScene[];
  captions: string; // ASS file relative to cwd (relative avoids filter-path escaping on Windows)
  output: string;
  music?: { path: string; volume: number };
}

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

  const W2 = Math.round(VIDEO_W * 1.25);
  const H2 = Math.round(VIDEO_H * 1.25);
  const f: string[] = [];
  p.scenes.forEach((s, i) => {
    const frames = Math.round(s.durationSec * FPS);
    // Alternate slow push-in / pull-out for gentle motion on stills.
    const zoom = i % 2 === 0 ? `min(1+0.12*on/${frames},1.12)` : `max(1.12-0.12*on/${frames},1)`;
    f.push(
      `[${i}:v]scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},setsar=1,` +
        `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${VIDEO_W}x${VIDEO_H}:fps=${FPS},` +
        `trim=end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`
    );
    f.push(
      `[${n + i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `apad=whole_dur=${s.durationSec.toFixed(4)},atrim=duration=${s.durationSec.toFixed(4)}[a${i}]`
    );
  });
  f.push(`${p.scenes.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[vc][ac]`);
  f.push(`[vc]ass=${p.captions},format=yuv420p[vout]`);
  f.push(`[ac]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[narr]`);
  if (p.music) {
    f.push(`[${2 * n}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${p.music.volume.toFixed(3)}[mus]`);
    f.push(`[narr]asplit=2[n1][n2]`);
    f.push(`[mus][n1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`);
    f.push(`[n2][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else {
    f.push(`[narr]anull[aout]`);
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

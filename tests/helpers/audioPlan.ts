import type { RenderAudio } from '../../src/main/media/render';

/** A soundtrack section for render-plan tests (paths are not opened when only the arguments are built). */
export function testAudio(scenes: number, o: { music?: string; sfx?: { path: string; atSec: number[] }[] } = {}): RenderAudio {
  return {
    narrationGainDb: Array.from({ length: scenes }, () => 0),
    music: { path: o.music ?? 'm.m4a', gainDb: -4, envelope: 'stems/duck-envelope.wav' },
    sfx: (o.sfx ?? []).map((s) => ({ role: 'contextual' as const, path: s.path, gainDb: -10, atSec: s.atSec })),
    stems: { narration: 'stems/narration.flac', music: 'stems/music.flac', musicDry: 'stems/music-dry.flac', sfx: 'stems/sfx.flac' }
  };
}

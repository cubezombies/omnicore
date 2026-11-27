import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Pronunciation, ProviderStatus } from '../../shared/production';
import { speechTokens, spokenText, type SpeechToken } from './pronunciation';
import type { WordTiming } from '../media/captions';
import { CancelledError } from '../media/ffmpeg';
import { readWavPcm, wavDurationSec } from '../media/wav';
import { shapePauses } from './speechTiming';
import { ProviderUnavailableError, type NarrationProvider, type NarrationResult } from './types';

// Windows' built-in speech engine via PowerShell. SpeakProgress events give
// per-word audio offsets, which drive caption sync without a transcription model.
const SCRIPT = String.raw`
param([string]$Mode, [string]$TextFile, [string]$OutFile, [string]$Voice, [int]$Rate = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Mode -eq 'voices') {
  $v = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @{ voices = $v }))
  exit 0
}
if ($Voice) { $s.SelectVoice($Voice) }
$s.Rate = $Rate
$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
$null = Register-ObjectEvent -InputObject $s -EventName SpeakProgress -SourceIdentifier sp
$s.SetOutputToWaveFile($OutFile)
$s.Speak($text)
$s.SetOutputToNull()
Start-Sleep -Milliseconds 50
$words = @(Get-Event -SourceIdentifier sp | ForEach-Object { $a = $_.SourceEventArgs; @{ t = $a.Text; ms = [int]$a.AudioPosition.TotalMilliseconds; c = $a.CharacterPosition } })
Unregister-Event -SourceIdentifier sp
Remove-Event -SourceIdentifier sp -ErrorAction SilentlyContinue
$name = $s.Voice.Name
$s.Dispose()
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 -InputObject @{ voice = $name; words = $words }))
exit 0
`;

interface RawWord {
  t: string;
  ms: number;
  c: number;
}

/** Turn SAPI progress events into word timings (dedupe repeated multi-part tokens, derive end times). */
/**
 * Map SAPI's word events (character offsets in the respelled text) back onto the original words, so captions
 * show what was written ("NVIDIA"), never the respelling ("Envidia"). Words without an event are interpolated.
 */
export function timingsForTokens(tokens: SpeechToken[], raw: RawWord[], durationSec: number): WordTiming[] {
  const events = [...raw].sort((a, b) => a.ms - b.ms);
  let offset = 0;
  const starts = tokens.map((t) => {
    const s = offset;
    offset += t.spoken.length + 1;
    return s;
  });
  const out: { text: string; start: number | null }[] = tokens.map((t, i) => {
    const end = starts[i] + t.spoken.length;
    const ev = events.find((e) => e.c >= starts[i] && e.c < end);
    return { text: t.orig, start: ev ? ev.ms / 1000 : null };
  });
  // Interpolate missing starts between known neighbours.
  for (let i = 0; i < out.length; i++) {
    if (out[i].start !== null) continue;
    const prev = [...out.slice(0, i)].reverse().find((x) => x.start !== null)?.start ?? 0;
    const j = out.findIndex((x, k) => k > i && x.start !== null);
    const next = j >= 0 ? (out[j].start as number) : durationSec;
    const span = j >= 0 ? j - i + 1 : out.length - i + 1;
    out[i].start = prev + (next - prev) / span;
  }
  return out.map((w, i) => {
    const start = w.start as number;
    const next = i + 1 < out.length ? (out[i + 1].start as number) : durationSec;
    return { text: w.text, start, end: Math.max(start + 0.1, Math.min(next, start + 1.2, durationSec)) };
  });
}

export function toWordTimings(raw: RawWord[], durationSec: number): WordTiming[] {
  const seen = new Set<number>();
  const uniq = raw.filter((w) => (seen.has(w.c) ? false : (seen.add(w.c), true))).sort((a, b) => a.ms - b.ms);
  return uniq.map((w, i) => {
    const start = w.ms / 1000;
    const next = i + 1 < uniq.length ? uniq[i + 1].ms / 1000 : durationSec;
    return { text: w.t, start, end: Math.max(start + 0.1, Math.min(next, start + 1.2, durationSec)) };
  });
}

export class SapiNarration implements NarrationProvider {
  id = 'windows-sapi';
  label = 'Windows speech (SAPI)';
  costPerUnitUsd = 0;
  private scriptPath: string;

  constructor(
    private readonly tmpDir: string,
    private readonly voice: string,
    private readonly rate: number,
    private readonly pronunciations: Pronunciation[] = []
  ) {
    this.scriptPath = path.join(tmpDir, 'omnicore-sapi.ps1');
  }

  private run(args: string[], signal?: AbortSignal): Promise<string> {
    if (process.platform !== 'win32') return Promise.reject(new ProviderUnavailableError('Windows speech is only available on Windows.'));
    fs.mkdirSync(this.tmpDir, { recursive: true });
    if (!fs.existsSync(this.scriptPath) || fs.readFileSync(this.scriptPath, 'utf8') !== SCRIPT) fs.writeFileSync(this.scriptPath, SCRIPT, 'utf8');
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new CancelledError());
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath, ...args],
        { windowsHide: true, env: { ...process.env, TEMP: this.tmpDir, TMP: this.tmpDir } }
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      const onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => reject(new ProviderUnavailableError(`Could not start PowerShell for Windows speech: ${e.message}`)));
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) return reject(new CancelledError());
        if (code !== 0) return reject(new Error(`Windows speech failed: ${(err || out).trim().split(/\r?\n/).slice(0, 3).join(' ')}`));
        resolve(out);
      });
    });
  }

  async voices(signal?: AbortSignal): Promise<string[]> {
    const out = await this.run(['-Mode', 'voices'], signal);
    const v = (JSON.parse(out) as { voices: string[] | string }).voices;
    return Array.isArray(v) ? v : [v];
  }

  async check(signal?: AbortSignal): Promise<ProviderStatus> {
    const base = { id: this.id, kind: 'narration' as const, label: this.label, costPerUnitUsd: 0 };
    try {
      const voices = await this.voices(signal);
      if (!voices.length) return { ...base, available: false, detail: 'No Windows voices are installed.', options: [] };
      const ok = !this.voice || voices.includes(this.voice);
      return { ...base, available: ok, detail: ok ? `Voice: ${this.voice || voices[0]}` : `Voice "${this.voice}" is not installed.`, options: voices };
    } catch (e) {
      return { ...base, available: false, detail: (e as Error).message, options: [] };
    }
  }

  async synthesize(text: string, outWav: string, signal: AbortSignal): Promise<NarrationResult> {
    const textFile = `${outWav}.txt`;
    // The engine reads the respelled text; captions keep the original words (timings are mapped back below).
    const tokens = speechTokens(text, this.pronunciations);
    fs.writeFileSync(textFile, spokenText(tokens), 'utf8');
    try {
      const args = ['-Mode', 'speak', '-TextFile', textFile, '-OutFile', outWav, '-Rate', String(Math.round(this.rate))];
      if (this.voice) args.push('-Voice', this.voice);
      const out = await this.run(args, signal);
      const parsed = JSON.parse(out) as { voice: string; words: RawWord[] | RawWord | null };
      const raw = parsed.words ? (Array.isArray(parsed.words) ? parsed.words : [parsed.words]) : [];
      const durationSec = wavDurationSec(outWav);
      if (durationSec < 0.2) throw new Error('Windows speech produced an empty recording.');
      // Windows voices pause up to a second at commas and sentence ends (measured); trim those silences to natural lengths.
      const shaped = shapePauses(readWavPcm(outWav), timingsForTokens(tokens, raw, durationSec), { sentence: 0.42, clause: 0.22, word: 0.1 }, outWav);
      return { durationSec: shaped.durationSec, words: shaped.words, voice: parsed.voice };
    } finally {
      fs.rmSync(textFile, { force: true });
    }
  }
}

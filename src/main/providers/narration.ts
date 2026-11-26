import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderStatus } from '../../shared/production';
import type { WordTiming } from '../media/captions';
import { CancelledError } from '../media/ffmpeg';
import { wavDurationSec } from '../media/wav';
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

  constructor(private readonly tmpDir: string, private readonly voice: string, private readonly rate: number) {
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
    fs.writeFileSync(textFile, text, 'utf8');
    try {
      const args = ['-Mode', 'speak', '-TextFile', textFile, '-OutFile', outWav, '-Rate', String(Math.round(this.rate))];
      if (this.voice) args.push('-Voice', this.voice);
      const out = await this.run(args, signal);
      const parsed = JSON.parse(out) as { voice: string; words: RawWord[] | RawWord | null };
      const raw = parsed.words ? (Array.isArray(parsed.words) ? parsed.words : [parsed.words]) : [];
      const durationSec = wavDurationSec(outWav);
      if (durationSec < 0.2) throw new Error('Windows speech produced an empty recording.');
      return { durationSec, words: toWordTimings(raw, durationSec), voice: parsed.voice };
    } finally {
      fs.rmSync(textFile, { force: true });
    }
  }
}

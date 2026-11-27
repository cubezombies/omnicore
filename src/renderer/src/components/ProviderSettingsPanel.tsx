import { VoiceList } from './VoiceList';
import { useEffect, useState } from 'react';
import {
  KOKORO_VOICES,
  PIPER_VOICES,
  RESEARCH_PROVIDERS,
  VISUAL_PROVIDERS,
  type AudioTrack,
  type KokoroVoiceId,
  type PiperVoiceId,
  type Pronunciation,
  type ProviderSettings,
  type ProviderStatus,
  type VisualProviderId,
  type VoiceSample
} from '../../../shared/production';

export function parsePronunciations(text: string): Pronunciation[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split('='))
    .filter((p) => p.length >= 2 && p[0].trim() && p.slice(1).join('=').trim())
    .map((p) => ({ term: p[0].trim(), say: p.slice(1).join('=').trim() }));
}
import { errorText } from './ProductionDetail';

const VISUAL_LABELS: Record<VisualProviderId, string> = {
  'wikimedia-commons': 'Wikimedia Commons (free licensed images)',
  openverse: 'Openverse (openly licensed images)',
  graphics: 'Explanatory graphics (stats, steps, sources; local)',
  comfyui: 'ComfyUI (local image generation)',
  'title-card': 'Title cards (local fallback)'
};

export function ProviderSettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<ProviderSettings | null>(null);
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [voiceToInstall, setVoiceToInstall] = useState<PiperVoiceId>(PIPER_VOICES[0].id);
  const [installing, setInstalling] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [sample, setSample] = useState<VoiceSample | null>(null);
  const [pronText, setPronText] = useState('');

  const check = () => {
    setChecking(true);
    window.api
      .checkProviders()
      .then(setStatus)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    void window.api.getSettings().then((x) => {
      setS(x);
      setPronText(x.pronunciations.map((p) => `${p.term} = ${p.say}`).join('\n'));
    });
    void window.api.listSounds().then(setTracks);
    check();
  }, []);

  if (!s) return <p className="muted">Loading providers…</p>;
  const set = <K extends keyof ProviderSettings>(k: K, v: ProviderSettings[K]) => {
    setS({ ...s, [k]: v });
    setMsg(null);
  };
  const opts = (id: string) => status?.find((x) => x.id === id)?.options ?? [];
  const toggleVisual = (id: VisualProviderId, on: boolean) =>
    set('visuals', on ? [...s.visuals, id] : s.visuals.filter((x) => x !== id));
  const move = (id: VisualProviderId, dir: -1 | 1) => {
    const v = [...s.visuals];
    const i = v.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= v.length) return;
    [v[i], v[j]] = [v[j], v[i]];
    set('visuals', v);
  };

  async function install() {
    setInstalling(true);
    setError(null);
    setMsg('Installing Piper…');
    try {
      setS(await window.api.installPiper(voiceToInstall));
      setMsg('Piper voice installed and selected.');
      check();
    } catch (e) {
      setError(errorText(e));
      setMsg(null);
    } finally {
      setInstalling(false);
    }
  }

  async function installKokoroNow() {
    setInstalling(true);
    setError(null);
    setMsg('Installing Kokoro (this downloads ~375 MB)…');
    try {
      setS(await window.api.installKokoro());
      setMsg('Kokoro installed and selected.');
      check();
    } catch (e) {
      setError(errorText(e));
      setMsg(null);
    } finally {
      setInstalling(false);
    }
  }

  async function playSample() {
    setSampling(true);
    setError(null);
    try {
      await window.api.saveSettings(s!);
      const smp = await window.api.generateVoiceSample();
      setSample(smp);
      setS(await window.api.getSettings());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSampling(false);
    }
  }

  async function save() {
    setError(null);
    try {
      setS(await window.api.saveSettings(s!));
      setMsg('Saved. New and retried productions use these settings.');
      check();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section className="panel" aria-labelledby="providers-heading">
      <header className="panel-head">
        <h2 id="providers-heading">Providers</h2>
        <span className="muted small">All built-in providers are free and run locally or use free public APIs.</span>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="settings-grid">
        <fieldset>
          <legend>Research sources</legend>
          {RESEARCH_PROVIDERS.map((r) => {
            const st = status?.find((x) => x.id === `research:${r.id}`);
            return (
              <label key={r.id} className="check" title={r.description}>
                <input
                  type="checkbox"
                  checked={s.researchProviders.includes(r.id)}
                  onChange={(e) => set('researchProviders', e.target.checked ? [...s.researchProviders, r.id] : s.researchProviders.filter((x) => x !== r.id))}
                />
                <span>
                  {r.label} <span className="muted small">· {r.category}{st ? (st.available ? ' · reachable' : ' · unreachable') : ''}</span>
                </span>
              </label>
            );
          })}
          <label className="field">
            <span>News mode: only use items from the last {s.newsWindowDays} days</span>
            <input type="number" min={1} max={365} value={s.newsWindowDays} onChange={(e) => set('newsWindowDays', Number(e.target.value))} />
          </label>
          <p className="muted small">All sources are free and need no account. A linked content item's research notes are always used too. Hacker News is used only to discover links.</p>
        </fieldset>

        <fieldset>
          <legend>Script writer</legend>
          <label className="check">
            <input type="radio" name="writer" checked={s.writer === 'extractive'} onChange={() => set('writer', 'extractive')} />
            Deterministic: narrates sourced facts verbatim (no AI, offline)
          </label>
          <label className="check">
            <input type="radio" name="writer" checked={s.writer === 'openai-compatible'} onChange={() => set('writer', 'openai-compatible')} />
            Strata / local LLM (any OpenAI-compatible server)
          </label>
          {s.writer === 'openai-compatible' && (
            <>
              <label className="field">
                <span>Server URL</span>
                <input value={s.llmBaseUrl} onChange={(e) => set('llmBaseUrl', e.target.value)} />
              </label>
              <label className="field">
                <span>Model (blank = discover the loaded model)</span>
                <input list="llm-models" value={s.llmModel} onChange={(e) => set('llmModel', e.target.value)} />
                <datalist id="llm-models">
                  {opts('openai-compatible').map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span>Timeout (seconds)</span>
                <input type="number" min={10} max={1800} value={s.llmTimeoutSec} onChange={(e) => set('llmTimeoutSec', Number(e.target.value))} />
              </label>
              <label className="check">
                <input type="checkbox" checked={s.writerFallback} onChange={(e) => set('writerFallback', e.target.checked)} />
                Fall back to the deterministic writer if the LLM is unavailable or its script fails validation
              </label>
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>Narration</legend>
          <label className="check">
            <input type="radio" name="narration" checked={s.narration === 'sherpa'} onChange={() => set('narration', 'sherpa')} />
            Kokoro (local neural voice, Apache-2.0; recommended)
          </label>
          <label className="check">
            <input type="radio" name="narration" checked={s.narration === 'windows-sapi'} onChange={() => set('narration', 'windows-sapi')} />
            Windows speech (built in, exact word timing)
          </label>
          <label className="check">
            <input type="radio" name="narration" checked={s.narration === 'piper'} onChange={() => set('narration', 'piper')} />
            Piper (local voice; fallback option)
          </label>
          {s.narration === 'sherpa' ? (
            <>
              <VoiceList label="Kokoro voice" name="sherpaVoice" engine="sherpa" voices={KOKORO_VOICES.map((v) => ({ id: v.id, label: v.label }))} value={s.sherpaVoice} onSelect={(id) => set('sherpaVoice', id as KokoroVoiceId)} />
              {status?.find((x) => x.id === 'sherpa')?.available === false && (
                <div className="install-row">
                  <button className="secondary" disabled={installing} onClick={installKokoroNow}>
                    {installing ? 'Installing…' : 'Install Kokoro (~375 MB)'}
                  </button>
                </div>
              )}
              <label className="field">
                <span>Pause between sentences ({s.sentencePauseSec.toFixed(2)} s)</span>
                <input type="range" min={0.15} max={0.8} step={0.01} value={s.sentencePauseSec} onChange={(e) => set('sentencePauseSec', Number(e.target.value))} />
              </label>
            </>
          ) : s.narration === 'windows-sapi' ? (
            <VoiceList label="Windows voice" name="sapiVoice" engine="windows-sapi" voices={[{ id: '', label: 'System default', previewable: false }, ...opts('windows-sapi').map((v) => ({ id: v, label: v }))]} value={s.voice} onSelect={(id) => set('voice', id)} />
          ) : (
            <>
              <VoiceList label="Installed Piper voice" name="piperVoice" engine="piper" voices={[{ id: '', label: 'First installed', previewable: false }, ...opts('piper').map((v) => ({ id: v, label: v.split(/[\/]/).pop() ?? v }))]} value={s.piperVoice} onSelect={(id) => set('piperVoice', id)} />
              <div className="install-row">
                <select aria-label="Piper voice to install" value={voiceToInstall} onChange={(e) => setVoiceToInstall(e.target.value as PiperVoiceId)}>
                  {PIPER_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} · {v.license}
                    </option>
                  ))}
                </select>
                <button className="secondary" disabled={installing} onClick={install}>
                  {installing ? 'Installing…' : 'Install voice'}
                </button>
              </div>
              <p className="muted small">Downloads Piper and the voice (free, ~60–80 MB) into the app's data folder. Only voices whose licence allows commercial use are listed.</p>
            </>
          )}
          <label className="field">
            <span>Speech rate ({s.speechRate})</span>
            <input type="range" min={-5} max={5} step={1} value={s.speechRate} onChange={(e) => set('speechRate', Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Pronunciations (one per line: TERM = how to say it)</span>
            <textarea
              rows={3}
              value={pronText}
              placeholder={'Omnicore = omni core\nKokoro = koh-koh-roh'}
              onChange={(e) => {
                setPronText(e.target.value);
                set('pronunciations', parsePronunciations(e.target.value));
              }}
            />
          </label>
          <div className="install-row">
            <button className="secondary" disabled={sampling} onClick={playSample} title="Save providers first so the sample uses these settings">
              {sampling ? 'Generating…' : 'Generate voice sample'}
            </button>
          </div>
          {sample && (
            <div className="sample">
              <audio controls autoPlay src={sample.url} aria-label="Voice sample" />
              <span className="muted small">
                {sample.engine} · {sample.voice} · {sample.durationSec.toFixed(1)} s · {sample.wordsPerSec.toFixed(2)} words/s (scripts are sized to this speed)
              </span>
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>Visuals (tried in order)</legend>
          {[...s.visuals, ...VISUAL_PROVIDERS.filter((v) => !s.visuals.includes(v))].map((id) => {
            const on = s.visuals.includes(id);
            return (
              <div key={id} className="visual-row">
                <label className="check">
                  <input type="checkbox" checked={on} onChange={(e) => toggleVisual(id, e.target.checked)} />
                  {VISUAL_LABELS[id]}
                </label>
                {on && (
                  <span>
                    <button className="ghost small-btn" aria-label={`Move ${VISUAL_LABELS[id]} up`} onClick={() => move(id, -1)}>
                      ↑
                    </button>
                    <button className="ghost small-btn" aria-label={`Move ${VISUAL_LABELS[id]} down`} onClick={() => move(id, 1)}>
                      ↓
                    </button>
                  </span>
                )}
              </div>
            );
          })}
          <label className="check">
            <input type="checkbox" checked={s.allowShareAlike} onChange={(e) => set('allowShareAlike', e.target.checked)} />
            Allow CC BY-SA images (videos using them must be shared alike)
          </label>
          <p className="muted small">Only images whose licence verifiably allows commercial use and editing are used (CC0, public domain, CC BY{s.allowShareAlike ? ', CC BY-SA' : ''}). Non-commercial, no-derivatives, logo/trademark and unclear files are rejected; AI images are labelled on screen.</p>
          {s.visuals.includes('comfyui') && (
            <>
              <label className="field">
                <span>ComfyUI URL</span>
                <input value={s.comfyUrl} onChange={(e) => set('comfyUrl', e.target.value)} />
              </label>
              <label className="field">
                <span>Checkpoint</span>
                <input list="comfy-ckpts" value={s.comfyCheckpoint} onChange={(e) => set('comfyCheckpoint', e.target.value)} />
                <datalist id="comfy-ckpts">
                  {opts('comfyui').map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>Music, sound &amp; render</legend>
          <label className="field">
            <span>Background music (from the Sound Library, ducked under narration)</span>
            <select
              value={s.musicMode === 'track' ? String(s.musicTrackId) : s.musicMode}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'none' || v === 'auto') setS({ ...s, musicMode: v });
                else setS({ ...s, musicMode: 'track', musicTrackId: Number(v) });
                setMsg(null);
              }}
            >
              <option value="none">No music</option>
              <option value="auto">Auto: pick a library track</option>
              {tracks
                .filter((t) => t.kind === 'music')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Music volume ({Math.round(s.musicVolume * 100)}%)</span>
            <input type="range" min={0} max={0.5} step={0.01} value={s.musicVolume} onChange={(e) => set('musicVolume', Number(e.target.value))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={s.sfxTransitions} onChange={(e) => set('sfxTransitions', e.target.checked)} />
            Transition sound at scene cuts
          </label>
          {s.sfxTransitions && (
            <label className="field">
              <span>Effect volume ({Math.round(s.sfxVolume * 100)}%)</span>
              <input type="range" min={0} max={1} step={0.05} value={s.sfxVolume} onChange={(e) => set('sfxVolume', Number(e.target.value))} />
            </label>
          )}
          <label className="field">
            <span>FFmpeg path (blank = bundled)</span>
            <input value={s.ffmpegPath} onChange={(e) => set('ffmpegPath', e.target.value)} />
          </label>
        </fieldset>
      </div>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="prod-actions">
        <button className="primary" onClick={save}>
          Save providers
        </button>
        <button className="secondary" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check providers'}
        </button>
        {msg && (
          <span className="muted small" role="status">
            {msg}
          </span>
        )}
      </div>

      {status && (
        <ul className="provider-status" aria-label="Provider status">
          {status.map((p) => (
            <li key={p.id}>
              <span className={p.available ? 'ok-dot' : 'bad-dot'} aria-hidden="true" />
              <strong>{p.label}</strong>
              <span className="muted small">
                {p.available ? 'Available' : 'Unavailable'} · {p.detail} · {p.costPerUnitUsd === 0 ? 'free' : usdUnit(p.costPerUnitUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const usdUnit = (n: number) => `$${n}/unit`;

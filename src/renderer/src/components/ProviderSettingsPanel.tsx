import { useEffect, useState } from 'react';
import { VISUAL_PROVIDERS, type ProviderSettings, type ProviderStatus, type VisualProviderId } from '../../../shared/production';
import { errorText } from './ProductionDetail';

const VISUAL_LABELS: Record<VisualProviderId, string> = {
  'wikimedia-commons': 'Wikimedia Commons (free licensed images)',
  comfyui: 'ComfyUI (local image generation)',
  'title-card': 'Title cards (local fallback)'
};

export function ProviderSettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<ProviderSettings | null>(null);
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = () => {
    setChecking(true);
    window.api
      .checkProviders()
      .then(setStatus)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    void window.api.getSettings().then(setS);
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
          <legend>Research</legend>
          <label className="check">
            <input type="checkbox" checked={s.wikipediaResearch} onChange={(e) => set('wikipediaResearch', e.target.checked)} />
            Wikipedia (needs internet)
          </label>
          <p className="muted small">A linked content item's research notes are always used as a source too.</p>
        </fieldset>

        <fieldset>
          <legend>Script writer</legend>
          <label className="check">
            <input type="radio" name="writer" checked={s.writer === 'extractive'} onChange={() => set('writer', 'extractive')} />
            Extractive: narrates sourced facts verbatim (no AI)
          </label>
          <label className="check">
            <input type="radio" name="writer" checked={s.writer === 'openai-compatible'} onChange={() => set('writer', 'openai-compatible')} />
            Local LLM (LM Studio, Ollama or any OpenAI-compatible server)
          </label>
          {s.writer === 'openai-compatible' && (
            <>
              <label className="field">
                <span>Server URL</span>
                <input value={s.llmBaseUrl} onChange={(e) => set('llmBaseUrl', e.target.value)} />
              </label>
              <label className="field">
                <span>Model (blank = first loaded)</span>
                <input list="llm-models" value={s.llmModel} onChange={(e) => set('llmModel', e.target.value)} />
                <datalist id="llm-models">
                  {opts('openai-compatible').map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
            </>
          )}
        </fieldset>

        <fieldset>
          <legend>Narration</legend>
          <label className="field">
            <span>Windows voice</span>
            <select value={s.voice} onChange={(e) => set('voice', e.target.value)}>
              <option value="">System default</option>
              {opts('windows-sapi').map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Speech rate ({s.speechRate})</span>
            <input type="range" min={-5} max={5} step={1} value={s.speechRate} onChange={(e) => set('speechRate', Number(e.target.value))} />
          </label>
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
          <legend>Audio &amp; render</legend>
          <label className="field">
            <span>Background music file (optional, absolute path; ducked under narration)</span>
            <input value={s.musicPath} placeholder="F:\Music\bed.mp3" onChange={(e) => set('musicPath', e.target.value)} />
          </label>
          <label className="field">
            <span>Music volume ({Math.round(s.musicVolume * 100)}%)</span>
            <input type="range" min={0} max={0.5} step={0.01} value={s.musicVolume} onChange={(e) => set('musicVolume', Number(e.target.value))} />
          </label>
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

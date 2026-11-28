import { useCallback, useEffect, useState } from 'react';
import type { ComfyDetection, ComfyGeneration, ComfyModel, ComfyStatus, GpuInfo } from '../../../shared/comfy';
import { errorText } from './ProductionDetail';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—');

/**
 * Managed ComfyUI inside Omnicore: runtime control and health, GPU memory, guided setup, model approval (with licence),
 * the generation in progress and this business's generation history. No separate ComfyUI window is needed.
 */
export function ComfyPanel() {
  const [st, setSt] = useState<{ runtime: ComfyStatus; gpu: GpuInfo | null; progress: { generationId: number; fraction: number; detail: string } | null; model: string } | null>(null);
  const [det, setDet] = useState<ComfyDetection | null>(null);
  const [models, setModels] = useState<ComfyModel[] | null>(null);
  const [hist, setHist] = useState<ComfyGeneration[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approve, setApprove] = useState<{ file: string; license: string; url: string; note: string } | null>(null);
  const load = useCallback(() => {
    void Promise.all([window.api.comfyStatus(), window.api.comfyHistory()])
      .then(([s, h]) => {
        setSt(s);
        setHist(h);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      load();
    }
  };
  if (!st) return null;
  const r = st.runtime;
  return (
    <details className="card">
      <summary>
        <strong>ComfyUI</strong> · {r.state}
        {r.system ? ` · ComfyUI ${r.system.version}` : ''}
        {st.gpu ? ` · GPU ${st.gpu.freeMb} MB free of ${st.gpu.totalMb} MB` : ' · no NVIDIA GPU detected'}
        {st.progress ? ` · generating ${Math.round(st.progress.fraction * 100)}%` : ''}
      </summary>
      {error && <p className="field-error small" role="alert">{error}</p>}
      {r.lastError && <p className="field-error small">{r.lastError}</p>}
      <div className="prod-actions">
        <button className="secondary" disabled={!!busy || r.state === 'running' || r.state === 'starting'} onClick={() => void act('start', () => window.api.comfyStart())}>
          {busy === 'start' ? 'Starting…' : 'Start'}
        </button>
        <button className="secondary" disabled={!!busy || r.state !== 'running'} onClick={() => void act('stop', () => window.api.comfyStop())}>
          Stop
        </button>
        <button className="secondary" disabled={!!busy || r.state !== 'running'} onClick={() => void act('restart', () => window.api.comfyRestart())}>
          Restart
        </button>
        <button className="ghost" disabled={!!busy} onClick={() => void act('detect', async () => setDet(await window.api.comfyDetect()))}>
          {busy === 'detect' ? 'Checking…' : 'Check setup'}
        </button>
        <button className="ghost" disabled={!!busy} onClick={() => void act('models', async () => setModels(await window.api.comfyModels()))}>
          Models
        </button>
      </div>
      {st.gpu && st.gpu.processes.length > 0 && (
        <p className="muted small">GPU memory in use: {st.gpu.processes.map((p) => `${p.name}${p.usedMb ? ` ${p.usedMb} MB` : ''}`).join(', ')}. Generation starts only when enough memory is free; nothing else is stopped automatically.</p>
      )}
      {det && (
        <div className="small">
          <p>
            {det.ok ? 'Setup complete.' : 'Setup needs attention.'} Installation: {det.installDir ?? 'not found'} · ComfyUI {det.version ?? '?'} · PyTorch {det.torch ?? '?'} · CUDA {det.cuda === null ? '?' : det.cuda ? `yes (${det.gpu})` : 'no'} · models: {det.modelsRoot ?? 'not found'}
          </p>
          {det.problems.length > 0 && (
            <ul className="field-error">
              {det.problems.map((p, i) => (
                <li key={p}>
                  {p} <span className="muted">{det.setup[i]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {models && (
        <div className="small">
          <p className="muted">A model is used for production visuals only after you approve it with its licence. Selected: {st.model || 'none'} (choose in Studio → Providers).</p>
          <table className="rights-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Base</th>
                <th scope="col">Size</th>
                <th scope="col">Production use</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.file}>
                  <td className="mono">{m.file}</td>
                  <td>{m.base || '—'}</td>
                  <td>{(m.sizeMb / 1024).toFixed(1)} GB</td>
                  <td>{m.approved ? `Approved · ${m.license}` : 'Not approved'}</td>
                  <td>
                    {m.approved ? (
                      <button className="ghost" onClick={() => void act('revoke', async () => (await window.api.comfyRevokeModel(m.file, 'revoked by user'), setModels(await window.api.comfyModels())))}>
                        Revoke
                      </button>
                    ) : (
                      <button className="ghost" onClick={() => setApprove({ file: m.file, license: '', url: '', note: '' })}>
                        Approve…
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {approve && (
            <div className="prod-actions">
              <span className="mono">{approve.file}</span>
              <input aria-label="Licence" placeholder="Licence (e.g. CreativeML Open RAIL++-M)" value={approve.license} onChange={(e) => setApprove({ ...approve, license: e.target.value })} />
              <input aria-label="Licence URL" placeholder="Licence / model page URL" value={approve.url} onChange={(e) => setApprove({ ...approve, url: e.target.value })} />
              <button className="primary" disabled={approve.license.trim().length < 3} onClick={() => void act('approve', async () => (await window.api.comfyApproveModel(approve.file, approve.license, approve.url, approve.note), setApprove(null), setModels(await window.api.comfyModels())))}>
                Approve for production visuals
              </button>
              <button className="ghost" onClick={() => setApprove(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      <h4>Generations (this business)</h4>
      {hist.length === 0 ? (
        <p className="muted small">None yet.</p>
      ) : (
        <ul className="small">
          {hist.map((g) => (
            <li key={g.id}>
              #{g.id} · {when(g.createdAt)} · {g.productionId ? `production ${g.productionId} scene ${(g.sceneIndex ?? 0) + 1}` : 'verification'} · {g.status}
              {g.error ? ` · ${g.error.slice(0, 160)}` : ''} · <span className="muted">{g.model} · seed {g.seed}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

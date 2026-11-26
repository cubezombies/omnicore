import { useCallback, useEffect, useState } from 'react';
import type { AutonomySettings, EngineStatus, Idea } from '../../../shared/operations';
import { errorText } from '../components/ProductionDetail';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function Operations() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [cfg, setCfg] = useState<AutonomySettings | null>(null);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.api.engineStatus().then(setStatus);
    void window.api.listIdeas().then(setIdeas);
  }, []);
  useEffect(() => {
    void window.api.getAutonomy().then(setCfg);
    load();
    const off = window.api.onProductionChanged(() => load());
    const t = setInterval(load, 15000);
    return () => (off(), clearInterval(t));
  }, [load]);

  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (done) setMsg(done);
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  const set = <K extends keyof AutonomySettings>(k: K, v: AutonomySettings[K]) => cfg && setCfg({ ...cfg, [k]: v });
  const fresh = ideas.filter((i) => i.status === 'new');
  const decided = ideas.filter((i) => i.status !== 'new').slice(0, 15);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Operations</h1>
          <p className="muted">Autonomous discovery, selection and production. Nothing is published or paid for without your approval.</p>
        </div>
        <button className="secondary" disabled={!!busy} onClick={() => run('discover', async () => { const r = await window.api.runDiscoveryNow(); setMsg(`Discovery found ${r.candidates} stories, ${r.created} new ideas.`); })}>
          {busy === 'discover' ? 'Discovering…' : 'Run discovery now'}
        </button>
      </header>
      {error && <div className="banner error" role="alert">{error}</div>}
      {msg && <p className="muted small" role="status">{msg}</p>}

      {status && (
        <div className="goal-grid">
          <div className="goal">
            <span className="goal-label">Engine</span>
            <span className="goal-value">{status.enabled ? (status.running ? 'Running' : 'Starting') : 'Paused'}</span>
            <span className="muted small">{status.lastError ? `Last error: ${status.lastError}` : 'No errors'}</span>
          </div>
          <div className="goal">
            <span className="goal-label">Discovery</span>
            <span className="goal-value small">Last: {when(status.lastDiscoveryAt)}</span>
            <span className="muted small">Next: {status.enabled ? when(status.nextDiscoveryAt) : 'paused'}</span>
          </div>
          <div className="goal">
            <span className="goal-label">Productions today</span>
            <span className="goal-value">{status.productionsToday} / {cfg?.maxProductionsPerDay ?? '–'}</span>
            <span className="muted small">{status.activeProductionId ? `Working on #${status.activeProductionId}` : 'Idle'}</span>
          </div>
        </div>
      )}

      {cfg && (
        <section className="panel">
          <header className="panel-head"><h2>Autonomy</h2></header>
          <div className="settings-grid">
            <fieldset>
              <legend>Operation</legend>
              <label className="check"><input type="checkbox" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Run autonomously (discover, select, produce, QA)</label>
              <label className="check"><input type="checkbox" checked={cfg.keepRunningInTray} onChange={(e) => set('keepRunningInTray', e.target.checked)} /> Keep running in the system tray when the window is closed</label>
              <label className="check"><input type="checkbox" checked={cfg.runAtStartup} onChange={(e) => set('runAtStartup', e.target.checked)} /> Start in the background when Windows starts (installed app)</label>
            </fieldset>
            <fieldset>
              <legend>Schedule &amp; limits</legend>
              <label className="field"><span>Discover every (hours)</span><input type="number" min={1} max={168} value={cfg.discoveryEveryHours} onChange={(e) => set('discoveryEveryHours', Number(e.target.value))} /></label>
              <label className="field"><span>Max productions per day</span><input type="number" min={0} max={24} value={cfg.maxProductionsPerDay} onChange={(e) => set('maxProductionsPerDay', Number(e.target.value))} /></label>
              <label className="field"><span>Produce between (hour, local)</span>
                <span className="install-row"><input type="number" min={0} max={23} value={cfg.activeFromHour} onChange={(e) => set('activeFromHour', Number(e.target.value))} /><input type="number" min={0} max={24} value={cfg.activeToHour} onChange={(e) => set('activeToHour', Number(e.target.value))} /></span>
              </label>
              <label className="field"><span>Minimum idea score (0–100)</span><input type="number" min={0} max={100} value={cfg.minIdeaScore} onChange={(e) => set('minIdeaScore', Number(e.target.value))} /></label>
              <label className="field"><span>Automatic QA repair rounds</span><input type="number" min={0} max={5} value={cfg.maxRepairRounds} onChange={(e) => set('maxRepairRounds', Number(e.target.value))} /></label>
            </fieldset>
          </div>
          <div className="prod-actions">
            <button className="primary" disabled={!!busy} onClick={() => run('save', async () => setCfg(await window.api.saveAutonomy(cfg)), 'Saved.')}>Save autonomy</button>
          </div>
          {status && (
            <ul className="muted small">
              {status.limitations.map((l) => <li key={l}>{l}</li>)}
            </ul>
          )}
        </section>
      )}

      <h2>Idea pipeline ({fresh.length} waiting)</h2>
      {fresh.length === 0 ? <p className="empty">No ideas yet. Run discovery or enable autonomy.</p> : (
        <ul className="content-list">
          {fresh.map((i) => (
            <li key={i.id} className="idea">
              <div className="idea-main">
                <span className="badge stage-research">{i.score}</span> <strong>{i.topic}</strong> <span className="muted small">· {i.mode}</span>
                <div className="small muted">{i.headline}</div>
                <div className="small muted">{i.scoreDetail.notes?.join(' · ')} · {i.signals.length} signal(s): {[...new Set(i.signals.map((s) => s.publisher))].join(', ')}</div>
              </div>
              <span className="track-actions">
                <button className="secondary" disabled={!!busy} onClick={() => run(`p${i.id}`, () => window.api.produceIdea(i.id), 'Production started — see Studio.')}>Produce now</button>
                <button className="ghost" disabled={!!busy} onClick={() => run(`r${i.id}`, () => window.api.rejectIdea(i.id, 'not a fit'))}>Reject</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {decided.length > 0 && (
        <>
          <h2>Recent decisions</h2>
          <ul className="content-list">
            {decided.map((i) => (
              <li key={i.id} className="idea small"><span className="badge stage-review">{i.status}</span> {i.topic} <span className="muted">· {i.decision}</span></li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

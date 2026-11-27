import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PRODUCTION_FORMATS, STEP_LABELS, type Production, type ProductionFormat, type ProductionMode, type ProductionSummary } from '../../../shared/production';
import type { PageProps } from '../App';
import { ContentList, useContent } from '../components/ContentList';
import { ProductionDetail, StatusBadge, errorText, usd } from '../components/ProductionDetail';
import { ProviderSettingsPanel } from '../components/ProviderSettingsPanel';

function progressOf(p: ProductionSummary): number {
  const done = p.steps.filter((s) => s.status === 'done').length;
  const running = p.steps.find((s) => s.status === 'running');
  return (done + (running?.progress ?? 0)) / p.steps.length;
}

export function Studio({ channel, refreshKey, openEditor }: PageProps) {
  const [list, setList] = useState<ProductionSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Production | null>(null);
  const [topic, setTopic] = useState('');
  const [mode, setMode] = useState<ProductionMode>('explainer');
  const [format, setFormat] = useState<ProductionFormat>('standard');
  const [error, setError] = useState<string | null>(null);
  const [showProviders, setShowProviders] = useState(false);
  const { items } = useContent(channel.id, ['script', 'production', 'review'], refreshKey);

  const loadList = useCallback(() => {
    void window.api
      .listProductions(channel.id)
      .then((l) => {
        setList(l);
        setSelected((cur) => cur ?? l[0]?.id ?? null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [channel.id]);

  const loadDetail = useCallback((id: number | null) => {
    if (id === null) return setDetail(null);
    void window.api
      .getProduction(id)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, []);

  useEffect(loadList, [loadList, refreshKey]);
  useEffect(() => loadDetail(selected), [selected, loadDetail]);
  useEffect(
    () =>
      window.api.onProductionChanged((id) => {
        loadList();
        if (id === selected) loadDetail(id);
      }),
    [selected, loadList, loadDetail]
  );

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const p = await window.api.createProduction(channel.id, { topic, mode, format });
      setTopic('');
      setSelected(p.id);
      loadList();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section className="studio">
      <header className="page-head">
        <div>
          <h1>Studio</h1>
          <p className="muted">Turn a topic into a finished 1080×1920 video: research, script, voice, visuals, captions, render.</p>
        </div>
        <button className="secondary" onClick={() => setShowProviders((v) => !v)} aria-expanded={showProviders}>
          Providers
        </button>
      </header>

      {showProviders && <ProviderSettingsPanel onClose={() => setShowProviders(false)} />}

      <form className="new-prod" onSubmit={start}>
        <label className="field grow">
          <span>Topic</span>
          <input value={topic} maxLength={200} placeholder="e.g. how large language models work" onChange={(e) => setTopic(e.target.value)} />
        </label>
        <label className="field">
          <span>Type</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as ProductionMode)}>
            <option value="explainer">Explainer (background + research)</option>
            <option value="news">News (recent coverage)</option>
          </select>
        </label>
        <label className="field">
          <span>Length</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as ProductionFormat)}>
            {(Object.keys(PRODUCTION_FORMATS) as ProductionFormat[]).map((f) => (
              <option key={f} value={f}>{PRODUCTION_FORMATS[f].label}</option>
            ))}
          </select>
        </label>
        <button className="primary" type="submit" disabled={!topic.trim()}>
          Produce video
        </button>
      </form>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}

      <div className="studio-grid">
        <aside aria-label="Productions">
          <h2 className="list-head">Productions</h2>
          {list === null ? (
            <p className="muted">Loading…</p>
          ) : list.length === 0 ? (
            <p className="empty">No productions yet. Enter a topic above.</p>
          ) : (
            <ul className="prod-list">
              {list.map((p) => {
                const running = p.steps.find((s) => s.status === 'running');
                return (
                  <li key={p.id}>
                    <button className={p.id === selected ? 'prod-item active' : 'prod-item'} onClick={() => setSelected(p.id)} aria-current={p.id === selected}>
                      <span className="row-title">{p.topic}</span>
                      <span className="prod-meta">
                        <StatusBadge status={p.status} />
                        <span className="muted small">
                          {running ? STEP_LABELS[running.step] : p.durationSec ? `${p.durationSec.toFixed(0)}s` : ''} · {usd(p.costUsd)}
                        </span>
                      </span>
                      {(p.status === 'running' || p.status === 'queued') && (
                        <span className="meter thin" aria-hidden="true">
                          <span className="meter-fill" style={{ width: `${Math.round(progressOf(p) * 100)}%` }} />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
        <div>
          {detail ? (
            <ProductionDetail
              business={channel}
              production={detail}
              onDeleted={() => {
                setSelected(null);
                setDetail(null);
                loadList();
              }}
            />
          ) : (
            list && list.length > 0 && <p className="muted">Select a production.</p>
          )}
        </div>
      </div>

      <h2>Content in production</h2>
      <ContentList items={items} empty="Nothing in Script, Production or Review." onOpen={openEditor} />
    </section>
  );
}

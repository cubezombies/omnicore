import { useCallback, useEffect, useState } from 'react';
import type { Business, Topic, TopicDraft } from '../../../shared/business';

const clean = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Edit form for one topic (all AI configuration lives here). */
function TopicForm(props: { topic?: Topic; parentName?: string; onSave: (d: TopicDraft) => Promise<void>; onCancel: () => void }) {
  const t = props.topic;
  const [name, setName] = useState(t?.name ?? '');
  const [description, setDescription] = useState(t?.description ?? '');
  const [keywords, setKeywords] = useState(t?.keywords.join(', ') ?? '');
  const [exclusions, setExclusions] = useState(t?.exclusions.join(', ') ?? '');
  const [priority, setPriority] = useState(t?.priority ?? 3);
  const [researchPriority, setResearchPriority] = useState<Topic['researchPriority']>(t?.researchPriority ?? 'normal');
  const [discovery, setDiscovery] = useState(t?.discovery ?? '');
  const [objectives, setObjectives] = useState(t?.objectives ?? '');
  const [autonomousOk, setAutonomousOk] = useState(t?.autonomousOk ?? true);
  const [approvalRequired, setApprovalRequired] = useState(t?.approvalRequired ?? false);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card topic-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void props
          .onSave({ name, description, keywords: list(keywords), exclusions: list(exclusions), priority, researchPriority, discovery, objectives, autonomousOk, approvalRequired })
          .finally(() => setBusy(false));
      }}
    >
      <h3>{t ? `Edit “${t.name}”` : props.parentName ? `New subtopic of “${props.parentName}”` : 'New topic'}</h3>
      <div className="topic-form-grid">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus />
        </label>
        <label className="field">
          <span>Priority</span>
          <select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>
                {p} {p === 1 ? '(highest)' : p === 5 ? '(lowest)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span>Description and scope</span>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </label>
        <label className="field">
          <span>Keywords and phrases (comma-separated)</span>
          <input value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        </label>
        <label className="field">
          <span>Excluded subjects (comma-separated)</span>
          <input value={exclusions} onChange={(e) => setExclusions(e.target.value)} />
        </label>
        <label className="field">
          <span>Research priority</span>
          <select value={researchPriority} onChange={(e) => setResearchPriority(e.target.value as Topic['researchPriority'])}>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label className="field">
          <span>Discovery preferences</span>
          <input value={discovery} onChange={(e) => setDiscovery(e.target.value)} maxLength={1000} placeholder="e.g. prefer primary sources and lab announcements" />
        </label>
        <label className="field wide">
          <span>Content objectives</span>
          <input value={objectives} onChange={(e) => setObjectives(e.target.value)} maxLength={1000} />
        </label>
        <label className="check">
          <input type="checkbox" checked={autonomousOk} onChange={(e) => setAutonomousOk(e.target.checked)} /> Allow autonomous discovery for this topic
        </label>
        <label className="check">
          <input type="checkbox" checked={approvalRequired} onChange={(e) => setApprovalRequired(e.target.checked)} /> Require my approval before producing stories on it
        </label>
      </div>
      <div className="prod-actions">
        <button className="primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save topic'}
        </button>
        <button className="secondary" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The active business's topics: create, nest, edit, reorder, enable, archive, restore and delete. */
export function Topics(props: { business: Business }) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ topic?: Topic; parentId?: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.api.listTopics().then(setTopics, (e) => setError(clean(e)));
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(clean(e));
    }
  };

  const active = topics.filter((t) => t.status === 'active');
  const proposals = topics.filter((t) => t.status === 'proposed');
  const children = (parentId: number | null) => active.filter((t) => t.parentId === parentId && (showArchived || !t.archivedAt)).sort((a, b) => a.position - b.position);
  const move = (t: Topic, dir: -1 | 1) => {
    const sib = active.filter((x) => x.parentId === t.parentId).sort((a, b) => a.position - b.position);
    const i = sib.findIndex((x) => x.id === t.id);
    const j = i + dir;
    if (j < 0 || j >= sib.length) return;
    const ids = sib.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void act(() => window.api.reorderTopics(t.parentId, ids));
  };

  const row = (t: Topic, depth: number): React.ReactNode => {
    const kids = children(t.id);
    const siblings = active.filter((x) => x.parentId === t.parentId && !x.archivedAt).sort((a, b) => a.position - b.position);
    const idx = siblings.findIndex((x) => x.id === t.id);
    return (
      <li key={t.id}>
        <div className={`topic-row${t.archivedAt ? ' archived' : ''}${t.enabled ? '' : ' disabled'}`} style={{ paddingLeft: `${12 + depth * 24}px` }}>
          <label className="check topic-toggle" title={t.enabled ? 'Enabled' : 'Disabled'}>
            <input type="checkbox" checked={t.enabled} disabled={!!t.archivedAt} onChange={(e) => void act(() => window.api.updateTopic(t.id, { enabled: e.target.checked }))} aria-label={`${t.name} enabled`} />
          </label>
          <div className="topic-main">
            <strong>{t.name}</strong> <span className="pill">P{t.priority}</span>
            {t.approvalRequired && <span className="pill">Needs approval</span>}
            {!t.autonomousOk && <span className="pill muted">Manual only</span>}
            {t.archivedAt && <span className="pill muted">Archived</span>}
            {(t.description || t.keywords.length > 0) && (
              <div className="muted small">
                {t.description}
                {t.keywords.length ? `${t.description ? ' · ' : ''}${t.keywords.join(', ')}` : ''}
                {t.exclusions.length ? ` · excludes ${t.exclusions.join(', ')}` : ''}
              </div>
            )}
          </div>
          <div className="topic-actions">
            {!t.archivedAt ? (
              <>
                <button className="ghost small-btn" aria-label={`Move ${t.name} up`} disabled={idx <= 0} onClick={() => move(t, -1)}>
                  ↑
                </button>
                <button className="ghost small-btn" aria-label={`Move ${t.name} down`} disabled={idx < 0 || idx >= siblings.length - 1} onClick={() => move(t, 1)}>
                  ↓
                </button>
                <button className="ghost small-btn" onClick={() => setEditing({ topic: t })}>
                  Edit
                </button>
                <button className="ghost small-btn" onClick={() => setEditing({ parentId: t.id })}>
                  Add subtopic
                </button>
                <button className="ghost small-btn" onClick={() => void act(() => window.api.archiveTopic(t.id))}>
                  Archive
                </button>
              </>
            ) : (
              <>
                <button className="ghost small-btn" onClick={() => void act(() => window.api.restoreTopic(t.id))}>
                  Restore
                </button>
                <button
                  className="ghost small-btn danger"
                  onClick={() => {
                    if (window.confirm(`Delete “${t.name}” permanently? This cannot be undone.`)) void act(() => window.api.deleteTopic(t.id));
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
        {kids.length > 0 && <ul className="topic-tree">{kids.map((k) => row(k, depth + 1))}</ul>}
      </li>
    );
  };

  const save = async (d: TopicDraft) => {
    setError(null);
    try {
      if (editing?.topic) await window.api.updateTopic(editing.topic.id, d);
      else await window.api.createTopic({ ...d, parentId: editing?.parentId ?? null });
      setEditing(null);
      load();
    } catch (e) {
      setError(clean(e));
    }
  };

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Topics</h1>
          <p className="muted">What {props.business.name} covers. Discovery and AI agents use only enabled topics, and never change this list on their own.</p>
        </div>
        <button className="primary" onClick={() => setEditing({ parentId: null })}>
          New topic
        </button>
      </header>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {editing && <TopicForm key={editing.topic?.id ?? `new-${editing.parentId}`} topic={editing.topic} parentName={editing.parentId ? topics.find((t) => t.id === editing.parentId)?.name : undefined} onSave={save} onCancel={() => setEditing(null)} />}

      {proposals.length > 0 && (
        <div className="card">
          <h2>Suggested by AI</h2>
          <p className="muted small">These do nothing until you accept them.</p>
          <ul className="plain">
            {proposals.map((t) => (
              <li key={t.id} className="topic-row">
                <div className="topic-main">
                  <strong>{t.name}</strong>
                  {t.parentId && <span className="muted small"> under {topics.find((x) => x.id === t.parentId)?.name}</span>}
                  {t.keywords.length > 0 && <div className="muted small">{t.keywords.join(', ')}</div>}
                </div>
                <div className="topic-actions">
                  <button className="secondary small-btn" onClick={() => void act(() => window.api.decideTopicProposal(t.id, true))}>
                    Accept
                  </button>
                  <button className="ghost small-btn" onClick={() => void act(() => window.api.decideTopicProposal(t.id, false))}>
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="check small">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived topics
      </label>
      {children(null).length ? <ul className="topic-tree card">{children(null).map((t) => row(t, 0))}</ul> : <p className="muted">No topics yet. Add the subjects this business covers.</p>}
    </section>
  );
}

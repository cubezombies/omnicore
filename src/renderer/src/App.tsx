import { useCallback, useEffect, useState } from 'react';
import type { Channel, ContentItem } from '../../shared/domain';
import { ContentEditor } from './components/ContentEditor';
import { Dashboard } from './pages/Dashboard';
import { Research } from './pages/Research';
import { Studio } from './pages/Studio';
import { Library } from './pages/Library';
import { Business } from './pages/Business';
import { SoundLibraryPage } from './pages/SoundLibrary';
import { Operations } from './pages/Operations';
import { Accounts } from './pages/Accounts';

const PAGES = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'operations', label: 'Operations' },
  { key: 'research', label: 'Research' },
  { key: 'studio', label: 'Studio' },
  { key: 'library', label: 'Content Library' },
  { key: 'sounds', label: 'Sound Library' },
  { key: 'accounts', label: 'Accounts' },
  { key: 'business', label: 'Business' }
] as const;
export type PageKey = (typeof PAGES)[number]['key'];

/** What the editor is showing: nothing, a new draft, or an existing item. */
export type EditorTarget = null | 'new' | ContentItem;

export interface PageProps {
  channel: Channel;
  refreshKey: number;
  openEditor: (target: EditorTarget) => void;
}

export function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [page, setPage] = useState<PageKey>('dashboard');
  const [editor, setEditor] = useState<EditorTarget>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .listChannels()
      .then((list) => {
        setChannels(list);
        setChannelId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const channel = channels.find((c) => c.id === channelId) ?? null;

  const props: PageProps | null = channel ? { channel, refreshKey, openEditor: setEditor } : null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Omnicore</span>
        </div>
        <label className="channel-picker">
          <span className="label">Channel</span>
          {channels.length > 1 ? (
            <select value={channelId ?? ''} onChange={(e) => setChannelId(Number(e.target.value))} data-channel-name>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <strong data-channel-name>{channel?.name ?? '…'}</strong>
          )}
        </label>
        <nav aria-label="Main">
          {PAGES.map((p) => (
            <button
              key={p.key}
              data-nav
              className={page === p.key ? 'nav-item active' : 'nav-item'}
              aria-current={page === p.key ? 'page' : undefined}
              onClick={() => setPage(p.key)}
            >
              {p.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="content">
        {error && <div className="banner error">{error}</div>}
        {props && page === 'dashboard' && <Dashboard {...props} />}
        {props && page === 'research' && <Research {...props} />}
        {props && page === 'studio' && <Studio {...props} />}
        {props && page === 'library' && <Library {...props} />}
        {props && page === 'sounds' && <SoundLibraryPage />}
        {props && page === 'operations' && <Operations />}
        {props && page === 'accounts' && <Accounts />}
        {props && page === 'business' && <Business {...props} />}
      </main>

      {editor && channel && (
        <ContentEditor
          key={editor === 'new' ? 'new' : editor.id}
          channelId={channel.id}
          initial={editor === 'new' ? null : editor}
          onClose={() => setEditor(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

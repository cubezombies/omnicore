import { useCallback, useEffect, useState } from 'react';
import type { Channel, ContentItem } from '../../shared/domain';
import type { Business } from '../../shared/business';
import { ContentEditor } from './components/ContentEditor';
import { BusinessSwitcher } from './components/BusinessSwitcher';
import { Dashboard } from './pages/Dashboard';
import { Research } from './pages/Research';
import { Studio } from './pages/Studio';
import { Library } from './pages/Library';
import { SoundLibraryPage } from './pages/SoundLibrary';
import { Operations } from './pages/Operations';
import { Accounts } from './pages/Accounts';
import { Analytics } from './pages/Analytics';
import { Businesses } from './pages/Businesses';
import { BusinessSettings } from './pages/BusinessSettings';
import { Topics } from './pages/Topics';

/** Navigation is grouped by task. Module pages only appear for businesses that enable that module. */
const NAV = [
  { group: 'Work', items: [{ key: 'dashboard', label: 'Overview' }] },
  {
    group: 'Media',
    module: 'media',
    items: [
      { key: 'research', label: 'Research' },
      { key: 'studio', label: 'Studio' },
      { key: 'library', label: 'Content Library' },
      { key: 'sounds', label: 'Sound Library' }
    ]
  },
  {
    group: 'Business',
    items: [
      { key: 'topics', label: 'Topics' },
      { key: 'accounts', label: 'Accounts & Channels', module: 'media' },
      { key: 'operations', label: 'Operations', module: 'media' },
      { key: 'analytics', label: 'Analytics' },
      { key: 'settings', label: 'Business Settings' }
    ]
  }
] as const;
export type PageKey = (typeof NAV)[number]['items'][number]['key'] | 'businesses';

/** What the editor is showing: nothing, a new draft, or an existing item. */
export type EditorTarget = null | 'new' | ContentItem;

export interface PageProps {
  channel: Channel;
  refreshKey: number;
  openEditor: (target: EditorTarget) => void;
}

const hasModule = (b: Business, m?: string) => !m || b.modules.includes(m as Business['modules'][number]);

export function App() {
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [active, setActive] = useState<Business | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState<PageKey>('dashboard');
  const [editor, setEditor] = useState<EditorTarget>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The main process owns the active business; the renderer only displays it.
  const reload = useCallback(async () => {
    try {
      const [list, cur] = await Promise.all([window.api.listBusinesses(), window.api.activeBusiness()]);
      setBusinesses(list);
      setActive(cur);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  // The main process announces every switch; drop open records and refetch so nothing stale stays on screen.
  useEffect(
    () =>
      window.api.onBusinessChanged(() => {
        setEditor(null);
        setRefreshKey((k) => k + 1);
        void reload();
      }),
    [reload]
  );

  const switchTo = useCallback(
    async (id: number) => {
      try {
        const b = await window.api.switchBusiness(id);
        setEditor(null); // never carry an open record into another business
        setActive(b);
        setPage((p) => (NAV.flatMap((g) => g.items.map((i) => ({ ...i, groupModule: 'module' in g ? g.module : undefined }))).some((i) => i.key === p && hasModule(b, i.groupModule) && hasModule(b, 'module' in i ? i.module : undefined)) ? p : 'dashboard'));
        setRefreshKey((k) => k + 1);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
      }
    },
    [reload]
  );

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const props: PageProps | null = active ? { channel: active, refreshKey, openEditor: setEditor } : null;
  const shown: PageKey = active ? page : 'businesses';

  return (
    <div className="shell" style={active ? ({ '--biz-accent': active.accent } as React.CSSProperties) : undefined}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Omnicore</span>
        </div>
        <BusinessSwitcher businesses={businesses} active={active} onSwitch={(id) => void switchTo(id)} onManage={() => setPage('businesses')} />
        {active && (
          <nav aria-label="Main">
            {NAV.filter((g) => hasModule(active, 'module' in g ? g.module : undefined)).map((g) => (
              <div key={g.group} className="nav-group">
                <span className="nav-group-label">{g.group}</span>
                {g.items
                  .filter((i) => hasModule(active, 'module' in i ? i.module : undefined))
                  .map((p) => (
                    <button key={p.key} data-nav className={shown === p.key ? 'nav-item active' : 'nav-item'} aria-current={shown === p.key ? 'page' : undefined} onClick={() => setPage(p.key)}>
                      {p.label}
                    </button>
                  ))}
              </div>
            ))}
          </nav>
        )}
        <button className={shown === 'businesses' ? 'nav-item nav-footer active' : 'nav-item nav-footer'} aria-current={shown === 'businesses' ? 'page' : undefined} onClick={() => setPage('businesses')}>
          All businesses
        </button>
      </aside>

      {/* Keyed by business so every page remounts on a switch: nothing from the previous business stays on screen. */}
      <main className="content" key={active?.id ?? 'none'}>
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        {loaded && !active && <p className="banner">Choose or create a business to start.</p>}
        {shown === 'businesses' && <Businesses active={active} onSwitch={(id) => void switchTo(id)} onChanged={() => void reload()} />}
        {props && shown === 'dashboard' && <Dashboard {...props} />}
        {props && shown === 'research' && <Research {...props} />}
        {props && shown === 'studio' && <Studio {...props} />}
        {props && shown === 'library' && <Library {...props} />}
        {props && shown === 'sounds' && <SoundLibraryPage />}
        {props && shown === 'operations' && <Operations />}
        {props && shown === 'accounts' && <Accounts business={active!} />}
        {props && shown === 'topics' && <Topics business={active!} />}
        {props && shown === 'analytics' && <Analytics business={active!} />}
        {props && shown === 'settings' && <BusinessSettings business={active!} onSaved={() => void reload()} />}
      </main>

      {editor && active && (
        <ContentEditor key={editor === 'new' ? 'new' : editor.id} channelId={active.id} initial={editor === 'new' ? null : editor} onClose={() => setEditor(null)} onChanged={refresh} />
      )}
    </div>
  );
}

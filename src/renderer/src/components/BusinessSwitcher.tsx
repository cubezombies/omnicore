import { useEffect, useRef, useState } from 'react';
import { BUSINESS_TYPES, type Business } from '../../../shared/business';

/** Always-visible business selector: shows the active business and switches or manages businesses. */
export function BusinessSwitcher(props: { businesses: Business[]; active: Business | null; onSwitch: (id: number) => void; onManage: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const a = props.active;
  return (
    <div className="biz-switcher" ref={root}>
      <button className="biz-current" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-business-name={a?.name ?? ''}>
        <span className="biz-dot" style={{ background: a?.accent ?? 'var(--border)' }} aria-hidden="true">
          {a?.name.charAt(0).toUpperCase() ?? '?'}
        </span>
        <span className="biz-text">
          <span className="label">Business</span>
          <strong>{a?.name ?? 'None selected'}</strong>
          {a && <span className="muted small">{BUSINESS_TYPES[a.businessType].label}</span>}
        </span>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      {open && (
        <div className="biz-menu" role="menu">
          {props.businesses.map((b) => (
            <button
              key={b.id}
              role="menuitemradio"
              aria-checked={b.id === a?.id}
              className={b.id === a?.id ? 'biz-option active' : 'biz-option'}
              onClick={() => {
                setOpen(false);
                if (b.id !== a?.id) props.onSwitch(b.id);
              }}
            >
              <span className="biz-dot small" style={{ background: b.accent }} aria-hidden="true">
                {b.name.charAt(0).toUpperCase()}
              </span>
              <span>{b.name}</span>
              {b.id === a?.id && <span className="muted small">current</span>}
            </button>
          ))}
          <hr />
          <button
            role="menuitem"
            className="biz-option"
            onClick={() => {
              setOpen(false);
              props.onManage();
            }}
          >
            New or manage businesses…
          </button>
        </div>
      )}
    </div>
  );
}

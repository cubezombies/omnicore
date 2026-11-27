import type { DatabaseSync } from 'node:sqlite';
import type { Business } from '../../shared/business';
import type { BusinessRepository } from './businesses';

/** Raised when an operation has no valid business context or targets another business's data. Always fails closed. */
export class BusinessContextError extends Error {}

const OWNER_SQL = {
  production: 'SELECT channel_id AS b FROM productions WHERE id = ?',
  account: 'SELECT business_id AS b FROM platform_accounts WHERE id = ?',
  idea: 'SELECT brand_id AS b FROM ideas WHERE id = ?',
  content: 'SELECT channel_id AS b FROM content_items WHERE id = ?',
  incident: 'SELECT business_id AS b FROM incidents WHERE id = ?',
  publication: 'SELECT p.channel_id AS b FROM publications x JOIN productions p ON p.id = x.production_id WHERE x.id = ?',
  topic: 'SELECT business_id AS b FROM topics WHERE id = ?'
} as const;
export type OwnedKind = keyof typeof OWNER_SQL;

/**
 * The main process's record of which business the user is working in. The renderer can ask to switch, but every
 * request is checked here against the active business and against the owner of the record it touches.
 */
export class BusinessContext {
  private listeners = new Set<(b: Business) => void>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly businesses: BusinessRepository
  ) {}

  onChange(fn: (b: Business) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The active business id. Throws when none is selected or it was archived: never falls back to another business. */
  activeId(): number {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = 'activeBusiness'").get() as { value: string } | undefined;
    const id = Number(r?.value);
    if (!Number.isInteger(id) || id <= 0 || !this.businesses.exists(id)) throw new BusinessContextError('No business is selected. Choose one in Businesses.');
    if (this.businesses.get(id).archivedAt) throw new BusinessContextError('The selected business is archived. Choose or restore a business in Businesses.');
    return id;
  }
  active(): Business {
    return this.businesses.get(this.activeId());
  }
  /** Active business, or null when none is valid (for screens that must still render). */
  tryActive(): Business | null {
    try {
      return this.active();
    } catch {
      return null;
    }
  }

  setActive(id: unknown): Business {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0 || !this.businesses.exists(n)) throw new BusinessContextError('That business does not exist.');
    const b = this.businesses.get(n);
    if (b.archivedAt) throw new BusinessContextError(`${b.name} is archived. Restore it before switching to it.`);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('activeBusiness', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
    for (const l of this.listeners) l(b);
    return b;
  }

  /** A business id sent by the renderer must be the active business; anything else is rejected. */
  require(id: unknown): number {
    const active = this.activeId();
    if (Number(id) !== active) throw new BusinessContextError('This request is for a different business than the one selected. Reload the page and try again.');
    return active;
  }

  /** Owner of a record, or null when it doesn't exist. */
  ownerOf(kind: OwnedKind, id: number): number | null {
    const r = this.db.prepare(OWNER_SQL[kind]).get(id) as { b: number | null } | undefined;
    return r && r.b !== null ? Number(r.b) : null;
  }

  /** The record must exist and belong to the active business; another business's record looks exactly like a missing one. */
  own(kind: OwnedKind, id: number): number {
    const active = this.activeId();
    if (this.ownerOf(kind, id) !== active) throw new BusinessContextError(`That ${kind} was not found in ${this.businesses.get(active).name}.`);
    return id;
  }
}

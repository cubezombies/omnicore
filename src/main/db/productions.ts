import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SETTINGS,
  PRODUCTION_STEPS,
  type AssetKind,
  type Brief,
  type Production,
  type ProductionAsset,
  type ProductionStatus,
  type ProductionStep,
  type ProductionSummary,
  type ProviderSettings,
  type Source,
  type StepName,
  type Storyboard
} from '../../shared/production';
import { NotFoundError } from './repository';
import type { ApprovalState, PlatformMetadata, ProductionDestination } from '../../shared/operations';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

interface ProductionRow {
  id: number;
  channel_id: number;
  content_id: number | null;
  topic: string;
  mode: 'explainer' | 'news';
  format?: 'short' | 'standard';
  user_notes: string;
  status: ProductionStatus;
  current_step: StepName | null;
  error: string | null;
  sources: string;
  brief: string | null;
  storyboard: string | null;
  output_path: string | null;
  duration_sec: number | null;
  created_at: string;
  updated_at: string;
  idea_id: number | null;
  origin: 'manual' | 'autonomous';
  destinations: string;
  metadata: string;
  approval: ApprovalState;
  publish_status: string;
}
interface StepRow {
  step: StepName;
  status: ProductionStep['status'];
  attempts: number;
  progress: number;
  detail: string;
  error: string | null;
  cost_usd: number;
  started_at: string | null;
  finished_at: string | null;
}
interface AssetRow {
  id: number;
  kind: AssetKind;
  scene_index: number | null;
  path: string;
  provider: string;
  source_url: string;
  license: string;
  attribution: string;
  meta: string;
}

const toStep = (r: StepRow): ProductionStep => ({
  step: r.step,
  status: r.status,
  attempts: Number(r.attempts),
  progress: Number(r.progress),
  detail: r.detail,
  error: r.error,
  costUsd: Number(r.cost_usd),
  startedAt: r.started_at,
  finishedAt: r.finished_at
});
const toAsset = (r: AssetRow): ProductionAsset => ({
  id: Number(r.id),
  kind: r.kind,
  sceneIndex: r.scene_index === null ? null : Number(r.scene_index),
  path: r.path,
  provider: r.provider,
  sourceUrl: r.source_url,
  license: r.license,
  attribution: r.attribution,
  meta: JSON.parse(r.meta) as Record<string, unknown>
});

export interface StepPatch {
  status?: ProductionStep['status'];
  progress?: number;
  detail?: string;
  error?: string | null;
  addCostUsd?: number;
  incrementAttempts?: boolean;
  started?: boolean;
  finished?: boolean;
}

export type NewAsset = Omit<ProductionAsset, 'id' | 'sourceUrl' | 'license' | 'attribution' | 'meta'> &
  Partial<Pick<ProductionAsset, 'sourceUrl' | 'license' | 'attribution' | 'meta'>>;

export class ProductionRepository {
  constructor(private readonly db: DatabaseSync) {}

  // ---- settings -------------------------------------------------------
  getSettings(): ProviderSettings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'providers'`).get() as { value: string } | undefined;
    const saved = row ? (JSON.parse(row.value) as Partial<ProviderSettings>) : {};
    const merged = { ...DEFAULT_SETTINGS, ...saved };
    // 0.3 settings had only a Wikipedia toggle.
    if (!saved.researchProviders && saved.wikipediaResearch === false) merged.researchProviders = merged.researchProviders.filter((p) => p !== 'wikipedia');
    merged.wikipediaResearch = merged.researchProviders.includes('wikipedia');
    // 0.6.1: add the new visual sources once to existing settings (user can remove them afterwards).
    if (saved.visuals && (saved.visualsRev ?? 0) < 2) {
      const v = [...saved.visuals];
      if (!v.includes('openverse')) v.splice(v.includes('wikimedia-commons') ? v.indexOf('wikimedia-commons') + 1 : 0, 0, 'openverse');
      if (!v.includes('graphics')) v.splice(v.includes('title-card') ? v.indexOf('title-card') : v.length, 0, 'graphics');
      merged.visuals = v;
      merged.visualsRev = 2;
    }
    return merged;
  }

  saveSettings(s: ProviderSettings): ProviderSettings {
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES ('providers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(s));
    return this.getSettings();
  }

  // ---- productions ----------------------------------------------------
  create(
    channelId: number,
    topic: string,
    contentId: number | null,
    userNotes: string,
    mode: 'explainer' | 'news' = 'explainer',
    extra: { origin?: 'manual' | 'autonomous'; ideaId?: number | null; destinations?: ProductionDestination[]; format?: 'short' | 'standard' } = {}
  ): Production {
    this.db.exec('BEGIN');
    try {
      const res = this.db
        .prepare("INSERT INTO productions (id, channel_id, content_id, topic, user_notes, mode, origin, idea_id, destinations, format) VALUES ((SELECT max_id + 1 FROM id_high_water WHERE name = 'productions'),?,?,?,?,?,?,?,?,?)")
        .run(channelId, contentId, topic, userNotes, mode, extra.origin ?? 'manual', extra.ideaId ?? null, JSON.stringify(extra.destinations ?? []), extra.format ?? 'short');
      const id = Number(res.lastInsertRowid);
      const ins = this.db.prepare('INSERT INTO production_steps (production_id, step) VALUES (?, ?)');
      for (const s of PRODUCTION_STEPS) ins.run(id, s);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private row(id: number): ProductionRow {
    const r = this.db.prepare('SELECT * FROM productions WHERE id = ?').get(id) as ProductionRow | undefined;
    if (!r) throw new NotFoundError(`Production ${id} not found`);
    return r;
  }

  userNotes(id: number): string {
    return this.row(id).user_notes;
  }

  steps(id: number): ProductionStep[] {
    const rows = this.db.prepare('SELECT * FROM production_steps WHERE production_id = ?').all(id) as unknown as StepRow[];
    const byName = new Map(rows.map((r) => [r.step, toStep(r)]));
    const missing = PRODUCTION_STEPS.filter((s) => !byName.has(s));
    if (missing.length) {
      const ins = this.db.prepare('INSERT OR IGNORE INTO production_steps (production_id, step) VALUES (?, ?)');
      for (const m of missing) ins.run(id, m);
      return this.steps(id);
    }
    return PRODUCTION_STEPS.map((s) => byName.get(s)!);
  }

  assets(id: number, kind?: AssetKind): ProductionAsset[] {
    const rows = (kind
      ? this.db.prepare('SELECT * FROM production_assets WHERE production_id = ? AND kind = ? ORDER BY scene_index, id').all(id, kind)
      : this.db.prepare('SELECT * FROM production_assets WHERE production_id = ? ORDER BY kind, scene_index, id').all(id)) as unknown as AssetRow[];
    return rows.map(toAsset);
  }

  private summary(r: ProductionRow, steps: ProductionStep[]): ProductionSummary {
    return {
      id: Number(r.id),
      channelId: Number(r.channel_id),
      contentId: r.content_id === null ? null : Number(r.content_id),
      topic: r.topic,
      mode: r.mode ?? 'explainer',
      format: r.format ?? 'short',
      status: r.status,
      currentStep: r.current_step,
      error: r.error,
      outputPath: r.output_path,
      durationSec: r.duration_sec === null ? null : Number(r.duration_sec),
      costUsd: steps.reduce((sum, s) => sum + s.costUsd, 0),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      steps,
      origin: r.origin ?? 'manual',
      ideaId: r.idea_id === null || r.idea_id === undefined ? null : Number(r.idea_id),
      destinations: JSON.parse(r.destinations ?? '[]') as ProductionDestination[],
      approval: r.approval ?? 'none',
      publishStatus: r.publish_status ?? 'not_published'
    };
  }

  get(id: number): Production {
    const r = this.row(id);
    return {
      ...this.summary(r, this.steps(id)),
      sources: JSON.parse(r.sources) as Source[],
      brief: r.brief ? (JSON.parse(r.brief) as Brief) : null,
      storyboard: r.storyboard ? (JSON.parse(r.storyboard) as Storyboard) : null,
      metadata: JSON.parse(r.metadata ?? '{}') as Record<string, PlatformMetadata>,
      assets: this.assets(id)
    };
  }

  list(channelId: number): ProductionSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM productions WHERE channel_id = ? ORDER BY created_at DESC, id DESC')
      .all(channelId) as unknown as ProductionRow[];
    return rows.map((r) => this.summary(r, this.steps(Number(r.id))));
  }

  /** Productions that should be picked up by the runner, oldest first. */
  queued(): number[] {
    return (this.db.prepare(`SELECT id FROM productions WHERE status = 'queued' ORDER BY id`).all() as { id: number }[]).map((r) =>
      Number(r.id)
    );
  }

  update(
    id: number,
    p: Partial<{
      status: ProductionStatus;
      currentStep: StepName | null;
      error: string | null;
      sources: Source[];
      brief: Brief | null;
      storyboard: Storyboard | null;
      outputPath: string | null;
      durationSec: number | null;
      destinations: ProductionDestination[];
      metadata: Record<string, PlatformMetadata>;
      approval: ApprovalState;
      publishStatus: string;
    }>
  ): void {
    const map: Record<string, [string, (v: unknown) => unknown]> = {
      status: ['status', (v) => v],
      currentStep: ['current_step', (v) => v],
      error: ['error', (v) => v],
      sources: ['sources', (v) => JSON.stringify(v)],
      brief: ['brief', (v) => (v === null ? null : JSON.stringify(v))],
      storyboard: ['storyboard', (v) => (v === null ? null : JSON.stringify(v))],
      outputPath: ['output_path', (v) => v],
      durationSec: ['duration_sec', (v) => v],
      destinations: ['destinations', (v) => JSON.stringify(v)],
      metadata: ['metadata', (v) => JSON.stringify(v)],
      approval: ['approval', (v) => v],
      publishStatus: ['publish_status', (v) => v]
    };
    const keys = Object.keys(p).filter((k) => k in map && (p as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return;
    const set = keys.map((k) => `${map[k][0]} = ?`).join(', ');
    const vals = keys.map((k) => map[k][1]((p as Record<string, unknown>)[k])) as (string | number | null)[];
    this.db.prepare(`UPDATE productions SET ${set}, updated_at = ${NOW} WHERE id = ?`).run(...vals, id);
  }

  updateStep(id: number, step: StepName, p: StepPatch): void {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (p.status !== undefined) (sets.push('status = ?'), vals.push(p.status));
    if (p.progress !== undefined) (sets.push('progress = ?'), vals.push(Math.max(0, Math.min(1, p.progress))));
    if (p.detail !== undefined) (sets.push('detail = ?'), vals.push(p.detail));
    if (p.error !== undefined) (sets.push('error = ?'), vals.push(p.error));
    if (p.addCostUsd) (sets.push('cost_usd = cost_usd + ?'), vals.push(p.addCostUsd));
    if (p.incrementAttempts) sets.push('attempts = attempts + 1');
    if (p.started) sets.push(`started_at = ${NOW}`, 'finished_at = NULL');
    if (p.finished) sets.push(`finished_at = ${NOW}`);
    if (!sets.length) return;
    this.db.prepare(`UPDATE production_steps SET ${sets.join(', ')} WHERE production_id = ? AND step = ?`).run(...vals, id, step);
    this.db.prepare(`UPDATE productions SET updated_at = ${NOW} WHERE id = ?`).run(id);
  }

  /** Reset a step (and its progress) to pending; attempts and cost history are kept. */
  resetStep(id: number, step: StepName): void {
    this.db
      .prepare(`UPDATE production_steps SET status = 'pending', progress = 0, detail = '', error = NULL, started_at = NULL, finished_at = NULL WHERE production_id = ? AND step = ?`)
      .run(id, step);
  }

  addAsset(productionId: number, a: NewAsset): ProductionAsset {
    const res = this.db
      .prepare(
        'INSERT INTO production_assets (production_id, kind, scene_index, path, provider, source_url, license, attribution, meta) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(
        productionId,
        a.kind,
        a.sceneIndex,
        a.path,
        a.provider,
        a.sourceUrl ?? '',
        a.license ?? '',
        a.attribution ?? '',
        JSON.stringify(a.meta ?? {})
      );
    return this.assets(productionId).find((x) => x.id === Number(res.lastInsertRowid))!;
  }

  /** Delete one kind of asset for some scenes only (e.g. re-voicing the scenes that contain a corrected word). */
  deleteSceneAssets(productionId: number, kind: AssetKind, scenes: number[]): ProductionAsset[] {
    const gone = this.assets(productionId, kind).filter((a) => a.sceneIndex !== null && scenes.includes(a.sceneIndex));
    const del = this.db.prepare('DELETE FROM production_assets WHERE id = ?');
    for (const a of gone) del.run(a.id);
    return gone;
  }

  deleteAssets(productionId: number, kind: AssetKind): ProductionAsset[] {
    const gone = this.assets(productionId, kind);
    this.db.prepare('DELETE FROM production_assets WHERE production_id = ? AND kind = ?').run(productionId, kind);
    return gone;
  }

  delete(id: number): void {
    this.row(id);
    this.db.prepare('DELETE FROM productions WHERE id = ?').run(id);
  }

  /**
   * On startup: re-link finished videos whose output path was lost (older versions cleared it when a
   * production was re-run from QA, which does not re-render). Only links a rendered final.mp4 that exists.
   */
  restoreOutputs(productionsDir: string): number[] {
    const rows = this.db
      .prepare(`SELECT p.id, a.path, a.meta FROM productions p JOIN production_assets a ON a.production_id = p.id AND a.kind = 'video'
                WHERE p.status = 'completed' AND p.output_path IS NULL ORDER BY a.id`)
      .all() as { id: number; path: string; meta: string }[];
    const fixed: number[] = [];
    for (const r of rows) {
      const file = path.join(productionsDir, String(r.id), r.path);
      if (!fs.existsSync(file) || fixed.includes(Number(r.id))) continue;
      const dur = Number((JSON.parse(r.meta || '{}') as { durationSec?: number }).durationSec);
      this.update(Number(r.id), { outputPath: file, durationSec: Number.isFinite(dur) ? dur : null });
      fixed.push(Number(r.id));
    }
    return fixed;
  }

  /** On startup: anything left "running" was interrupted by an app exit. */
  markInterrupted(): number {
    const ids = (this.db.prepare(`SELECT id, current_step FROM productions WHERE status = 'running'`).all() as {
      id: number;
      current_step: StepName | null;
    }[]);
    for (const r of ids) {
      if (r.current_step) {
        this.updateStep(Number(r.id), r.current_step, { status: 'failed', error: 'Interrupted because the app was closed.' });
      }
      this.update(Number(r.id), { status: 'failed', error: 'Interrupted because the app was closed. Retry to resume.' });
    }
    return ids.length;
  }
}

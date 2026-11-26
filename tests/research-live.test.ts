// Live research run against the real free providers. Gated: AIMO_RESEARCH_LIVE=1, AIMO_RESEARCH_OUT=<dir>.
// Writes a JSON + Markdown report per topic: provider outcomes, sources with metadata, claims with kinds.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { adapterById } from '../src/main/research/adapters';
import { runResearch } from '../src/main/research/engine';
import { buildEvidenceBrief } from '../src/main/research/evidence';
import { CLAIM_KIND_LABELS, DEFAULT_SETTINGS, SOURCE_KIND_LABELS, type ProductionMode } from '../src/shared/production';

const run = process.env.AIMO_RESEARCH_LIVE === '1' ? describe : describe.skip;
const TOPICS: [string, ProductionMode][] = (process.env.AIMO_RESEARCH_TOPICS ?? 'how speech recognition works|explainer;speculative decoding|explainer;NVIDIA Blackwell GPUs|news;EU AI Act|news')
  .split(';')
  .map((t) => t.split('|') as [string, ProductionMode]);

run('live research', () => {
  for (const [topic, mode] of TOPICS) {
    it(`${mode}: ${topic}`, async () => {
      const out = process.env.AIMO_RESEARCH_OUT!;
      fs.mkdirSync(out, { recursive: true });
      const t0 = Date.now();
      let r;
      try {
        r = await runResearch({ topic, mode, windowDays: 30 }, DEFAULT_SETTINGS.researchProviders.map(adapterById), [], AbortSignal.timeout(240_000));
      } catch (e) {
        // An honest "not enough evidence" outcome is a valid result: record it.
        fs.writeFileSync(path.join(out, `${mode}-${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`), `# ${topic} (${mode})

Research refused: ${(e as Error).message}
`);
        return;
      }
      let claimsMd = '';
      let claims: unknown[] = [];
      try {
        const brief = buildEvidenceBrief(topic, r.sources, 'AI and technology', mode);
        claims = brief.claims ?? [];
        claimsMd = (brief.claims ?? []).map((c) => `- **${c.id}** ${CLAIM_KIND_LABELS[c.kind]}${c.kind === 'confirmed' ? '' : ` (attribute: ${c.attribution})`} · sources ${c.sourceIds.join(', ')} · ${c.independentSources} independent  \n  ${c.text}`).join('\n');
      } catch (e) {
        claimsMd = `_No brief: ${(e as Error).message}_`;
      }
      const slug = `${mode}-${topic.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      fs.writeFileSync(path.join(out, `${slug}.json`), JSON.stringify({ topic, mode, seconds: (Date.now() - t0) / 1000, reports: r.reports, sources: r.sources.map((s) => ({ ...s, excerpt: `${s.excerpt.slice(0, 300)}…` })), dropped: r.dropped, claims }, null, 1));
      const md = [
        `# ${topic} (${mode})`,
        `Research took ${((Date.now() - t0) / 1000).toFixed(1)} s.`,
        '',
        '## Providers',
        ...r.reports.map((p) => `- ${p.label}: ${p.status}${p.found ? `, ${p.found} found` : ''}${p.error ? ` — ${p.error}` : ''} (${(p.ms / 1000).toFixed(1)} s)`),
        '',
        '## Sources kept',
        ...r.sources.map((s) => `- **${s.id}** [${s.title}](${s.url}) — ${s.publisher} · ${SOURCE_KIND_LABELS[s.kind ?? 'other']} · ${s.publishedAt?.slice(0, 10) ?? 'no date'} · ${s.authors?.slice(0, 3).join(', ') || 'no author'} · ${s.contentLevel}${s.derivedFrom ? ` · repeats ${s.derivedFrom}` : ''}`),
        '',
        `## Dropped (${r.dropped.length})`,
        ...r.dropped.slice(0, 15).map((d) => `- ${d.title.slice(0, 90)} — ${d.reason}`),
        '',
        '## Claims',
        claimsMd
      ].join('\n');
      fs.writeFileSync(path.join(out, `${slug}.md`), md);
      expect(r.reports.length).toBe(DEFAULT_SETTINGS.researchProviders.length);
    }, 300_000);
  }
});

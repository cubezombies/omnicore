import type { Scene } from '../../shared/production';
import { significantTokens } from '../providers/text';
import { restrictionProblem } from './assetPolicy';

export interface Relevance {
  ok: boolean;
  /** Topic / scene words found in the asset's own title, description or tags. */
  matched: string[];
  reason: string;
}

const GENERIC_TOKENS = new Set(['ai', 'data', 'model', 'training', 'train', 'system', 'new', 'large', 'use', 'work', 'technology', 'computer', 'computing', 'research', 'study', 'future', 'accelerate']);

const hits = (want: Set<string>, have: string[]): string[] => [...want].filter((w) => have.some((h) => h === w || (w.length >= 4 && h.startsWith(w)) || (h.length >= 4 && w.startsWith(h))));

/**
 * Visual relevance gate for external images: the asset's own metadata must mention the video's topic
 * (anchored), and also the scene's subject unless it comes from a cited article. Logos, brand marks and
 * software screenshots are rejected outright, since they can mislead or belong to someone else.
 */
export function assetRelevance(meta: { title: string; description?: string; tags?: string[] }, scene: Pick<Scene, 'visualQuery' | 'narration'>, topic: string, opts: { fromCitedArticle?: boolean } = {}): Relevance {
  const title = meta.title.replace(/^File:/, '').replace(/\.\w+$/, '');
  const restricted = restrictionProblem('', '', title);
  if (restricted) return { ok: false, matched: [], reason: `rejected: ${restricted}` };
  const text = `${title} ${meta.description ?? ''}`;
  // Advocacy imagery frames a neutral story; someone else's chart shows figures our narration never states.
  if (/\b(protest|protesters?|rally|rallies|demonstrat\w*|placards?|picket\w*|boycott|petition|campaign sign|yard sign|anti[- ]\w+|no \w+ (sign|center|centre)|meme|cartoon|caricature)\b/i.test(text)) return { ok: false, matched: [], reason: 'rejected: advocacy or editorial imagery (would frame the story)' };
  if (/\b(charts?|graphs?|plots?|infographics?|histograms?|statistics|figure \d+|diagrams? of (prices|costs|growth))\b/i.test(title)) return { ok: false, matched: [], reason: "rejected: someone else's chart (its figures are not in our narration)" };
  // Damage imagery suggests something happened that the story doesn't say.
  if (/\b(broken|breaking|damaged|destroyed|smashed|burn(ed|t)|bending|crushed|explod\w*|fire|wreck\w*)\b/i.test(title)) return { ok: false, matched: [], reason: 'rejected: shows damage the story does not describe' };
  // If the narration names a model (H100, V100, M3…) and the image names a different one, it shows the wrong product.
  const models = (s: string) => new Set((s.match(/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{2,}\b/g) ?? []).map((m) => m.toLowerCase()).filter((m) => !/^\d+(b|m|k|x|s|th|st|nd|rd|gb|tb|mb|ms|w|kw|mw|gw)$/.test(m) && !/^(19|20)\d\d$/.test(m)));
  const said = models(scene.narration);
  const shown = models(`${title} ${(meta.tags ?? []).join(' ')}`);
  if (said.size && shown.size && ![...shown].some((m) => said.has(m))) return { ok: false, matched: [], reason: `rejected: shows ${[...shown].join('/')} but the narration is about ${[...said].join('/')}` };
  // Same for makers: an AMD card over narration about NVIDIA hardware shows the wrong company's product.
  const MAKERS: Record<string, string> = { nvidia: 'nvidia', geforce: 'nvidia', amd: 'amd', radeon: 'amd', ati: 'amd', intel: 'intel', apple: 'apple', google: 'google', tpu: 'google', qualcomm: 'qualcomm', samsung: 'samsung', tsmc: 'tsmc', microsoft: 'microsoft', meta: 'meta', openai: 'openai' };
  const makers = (s: string) => new Set((s.toLowerCase().match(/[a-z]+/g) ?? []).map((w) => MAKERS[w]).filter(Boolean));
  const saidMakers = makers(scene.narration);
  const shownMakers = makers(`${title} ${(meta.tags ?? []).join(' ')}`);
  if (saidMakers.size && shownMakers.size && ![...shownMakers].some((m) => saidMakers.has(m))) return { ok: false, matched: [], reason: `rejected: shows a ${[...shownMakers].join('/')} product but the narration is about ${[...saidMakers].join('/')}` };
  // An unrelated person shown over the narration implies they are involved.
  if (/\b(people|person|portrait|selfie|headshot|man|woman|men|women|boy|girl|crowd|audience|speaker|ceo|founder)\b/i.test(`${text} ${(meta.tags ?? []).join(' ')}`)) return { ok: false, matched: [], reason: 'rejected: shows people not named in the story' };
  const have = [...significantTokens(`${title} ${meta.description ?? ''} ${(meta.tags ?? []).join(' ')}`)];
  const inTitle = [...significantTokens(title)];
  const T = significantTokens(topic);
  // Generic words ("AI", "data", "training") can't anchor an image to the story on their own.
  const specific = new Set([...T].filter((w) => !GENERIC_TOKENS.has(w)));
  const anchors = specific.size ? specific : T;
  const Q = significantTokens(scene.visualQuery);
  const N = significantTokens(scene.narration);
  const mt = hits(T, have);
  const mq = hits(Q, have);
  const mn = hits(N, have);
  const titleAnchor = hits(anchors, inTitle);
  const matched = [...new Set([...mt, ...mq, ...mn])];
  const ok = opts.fromCitedArticle
    ? mt.length + mq.length >= 1
    : titleAnchor.length >= 1 && ((mt.length >= Math.min(2, T.size) && mt.length > 0) || mq.length + mn.length >= 1);
  if (!ok && !opts.fromCitedArticle && matched.length && !titleAnchor.length) return { ok, matched, reason: `the title names no specific topic word (matched only ${matched.join(', ')} via tags or generic words)` };
  return { ok, matched, reason: ok ? `matches ${matched.join(', ')}` : matched.length ? `only loosely related (${matched.join(', ')})` : 'no topic words in the image metadata' };
}

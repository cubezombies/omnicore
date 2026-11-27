/**
 * Topic relevance for discovery and manual production.
 *
 * Production 11 ("Ukraine downs Russian jet-drone") reached AI, Actually because the story contained "attack", a
 * keyword of the Cybersecurity topic. Topic keywords like "attack", "security", "law", "app", "tool", "model" or
 * "release" are generic: on their own they say nothing about AI. For a business whose niche is AI, a story is on topic
 * only when it also contains an AI term; keywords then add to how well it fits.
 */

/** Terms that make a story about AI. "AI" itself is matched in capitals only ("ai" occurs inside other words). */
export const AI_TERMS = [
  'AI',
  'A.I.',
  'artificial intelligence',
  'machine learning',
  'deep learning',
  'neural network',
  'neural networks',
  'LLM',
  'LLMs',
  'large language model',
  'language model',
  'language models',
  'generative',
  'GenAI',
  'chatbot',
  'chatbots',
  'ChatGPT',
  'GPT',
  'OpenAI',
  'Anthropic',
  'DeepMind',
  'Copilot',
  'Gemini',
  'Claude',
  'Llama',
  'Mistral',
  'DeepSeek',
  'Qwen',
  'Grok',
  'xAI',
  'Hugging Face',
  'Midjourney',
  'Stable Diffusion',
  'diffusion model',
  'computer vision',
  'AGI',
  'agentic',
  'AI agent',
  'AI agents',
  'vibe coding'
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CASE_SENSITIVE = new Set(['AI', 'A.I.', 'LLM', 'LLMs', 'GPT', 'AGI', 'GenAI', 'xAI']);

/** Which of `terms` occur in `text` as whole words. */
export function termHits(text: string, terms: string[]): string[] {
  return terms.filter((k) => {
    const cs = CASE_SENSITIVE.has(k) || (/^[A-Z0-9.]{2,}$/.test(k) && k.length <= 5);
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc(k)}(?=$|[^\\p{L}\\p{N}])`, cs ? 'u' : 'iu').test(text);
  });
}

/** The relevance anchors for a business: AI terms when its niche is AI, otherwise none (keywords alone decide). */
export function nicheAnchors(niche: string): string[] {
  return /\bAI\b|artificial intelligence|machine learning/i.test(niche) ? AI_TERMS : [];
}

export interface Relevance {
  onTopic: boolean;
  keywordHits: string[];
  anchorHits: string[];
  reason: string;
}

/** Is this text on topic for a business with these topic keywords and anchors? */
export function topicRelevance(text: string, keywords: string[], anchors: string[]): Relevance {
  const keywordHits = termHits(` ${text} `, keywords);
  const anchorHits = anchors.length ? termHits(` ${text} `, anchors) : [];
  if (!anchors.length) {
    return { onTopic: keywordHits.length > 0, keywordHits, anchorHits, reason: keywordHits.length ? `matches ${keywordHits.join(', ')}` : 'matches none of the topic keywords' };
  }
  if (anchorHits.length) return { onTopic: true, keywordHits, anchorHits, reason: `AI terms: ${anchorHits.join(', ')}` };
  return {
    onTopic: false,
    keywordHits,
    anchorHits,
    reason: keywordHits.length ? `only generic keywords (${keywordHits.join(', ')}) and no AI term` : 'no AI term and no topic keyword'
  };
}

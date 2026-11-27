import type { Pronunciation } from '../../shared/production';

/**
 * Pronunciation normalisation. Narration engines get a "spoken" form (GPU → "G P U",
 * $5B → "5 billion dollars"), while captions keep the original words: every token
 * remembers both, so timing estimated on the spoken form maps back to what viewers read.
 */
export interface SpeechToken {
  orig: string;
  spoken: string;
}

/** Built-in spellings for terms engines commonly get wrong. Case-sensitive keys. */
export const BUILTIN_LEXICON: Record<string, string> = {
  NVIDIA: 'Envidia',
  Omnicore: 'omni core',
  VRAM: 'vee-ram',
  'Dr.': 'Doctor',
  'Mr.': 'Mister',
  'Mrs.': 'Missus',
  'Ms.': 'Miz',
  'Prof.': 'Professor',
  'Jr.': 'Junior',
  'Sr.': 'Senior',
  'approx.': 'approximately',
  Nvidia: 'Envidia',
  ChatGPT: 'Chat G P T',
  'GPT-4o': 'G P T four oh',
  'GPT-4o-mini': 'G P T four oh mini',
  GPT: 'G P T',
  RAG: 'rag',
  ASIC: 'ay-sick',
  ASICs: 'ay-sicks',
  SQL: 'sequel',
  JSON: 'jason',
  YAML: 'yammel',
  arXiv: 'archive',
  PyTorch: 'pie torch',
  NumPy: 'num pie',
  ONNX: 'onyx',
  CUDA: 'cooda',
  TFLOPS: 'teraflops',
  PFLOPS: 'petaflops',
  FLOPS: 'flops',
  FLOPs: 'flops',
  DRAM: 'dee ram',
  SRAM: 'ess ram',
  NAND: 'nand',
  LiDAR: 'lie dar',
  LIDAR: 'lie dar',
  macOS: 'mac O S',
  iOS: 'eye O S',
  GitHub: 'git hub',
  xAI: 'x A I',
  Qwen: 'chwen',
  LLaMA: 'llama',
  DALL: 'dahl',
  'DALL-E': 'dahl ee',
  JPEG: 'jay peg',
  SaaS: 'sass',
  WiFi: 'wye fye',
  'Wi-Fi': 'wye fye',
  'e.g.': 'for example',
  'i.e.': 'that is',
  'etc.': 'et cetera',
  'vs.': 'versus',
  vs: 'versus',
  '&': 'and'
};

/** All-caps words that are read as words, not spelled out. */
// "AI" is in Kokoro's lexicon and is said correctly as written (spelling it out produced "I").
const WORDLIKE = new Set(['AI', 'NASA', 'NATO', 'RAM', 'ROM', 'LASER', 'RADAR', 'SIM', 'GIF', 'UNESCO', 'OPEC', 'FIFA', 'SWAT', 'COVID', 'CAPTCHA', 'BASIC', 'COBOL', 'FORTRAN', 'OK', 'NAND', 'RAG', 'SONAR', 'SCUBA', 'ASAP', 'IKEA', 'LEGO']);

const SCALE: Record<string, string> = { K: 'thousand', M: 'million', B: 'billion', T: 'trillion' };

/** How each letter is said in a plural acronym's last position ("GPUs" ends in "yooz"). */
const LETTER_PLURAL: Record<string, string> = {
  A: 'ayz', B: 'beez', C: 'seez', D: 'deez', E: 'eez', F: 'effs', G: 'jeez', H: 'aitches', I: 'eyes', J: 'jays', K: 'kays', L: 'els', M: 'emz',
  N: 'enz', O: 'ohz', P: 'peez', Q: 'cues', R: 'arz', S: 'esses', T: 'teez', U: 'yooz', V: 'veez', W: 'double-yooz', X: 'exes', Y: 'whys', Z: 'zeez'
};

/**
 * How an engine wants acronyms written. Each was chosen by synthesising the forms and checking them with Whisper:
 * - 'dotted' (Kokoro via sherpa-onnx, espeak-ng en-us): "GPU" → "G.P.U", "GPUs" → "G.P.yooz". Dotted letters keep acronym
 *   stress and are never read as a word ("AWS" alone is read "oz"); spaced letters were each stressed like separate
 *   words, and a plain plural lost its "s" (heard "GPS").
 * - 'spaced' (Piper, Windows voices): "G P U", "A-M-D" (a spaced lone "A" is read as the article), plural "G P U's".
 *   Dots were read as separate odd syllables on these engines.
 * - 'native' (Kokoro reference pipeline): misaki spells acronyms, plurals and model names correctly by itself.
 */
export type AcronymStyle = 'spaced' | 'dotted' | 'native';

export function spellAcronym(w: string, style: AcronymStyle = 'spaced'): string {
  const m = /^([A-Z]{2,6})(s?)$/.exec(w);
  if (!m || style === 'native') return w;
  const L = m[1].split('');
  if (style === 'dotted') {
    if (!m[2]) return L.join('.');
    const last = L.pop()!;
    return `${L.join('.')}.${LETTER_PLURAL[last]}`;
  }
  return L.join(m[1].includes('A') ? '-' : ' ') + (m[2] ? "'s" : '');
}

/** Respellings are written with spaced capitals ("G P T"); dotted engines get "G.P.T". */
const restyle = (spoken: string, style: AcronymStyle) => (style === 'dotted' ? spoken.replace(/\b[A-Z](?: [A-Z]\b)+/g, (x) => x.replace(/ /g, '.')) : spoken);

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const under100 = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);
/** A year in words, as people say it: 2026 → "twenty twenty-six", 2005 → "two thousand five", 1999 → "nineteen ninety-nine". */
export function yearWords(y: number): string {
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (y >= 2000 && y < 2010) return `two thousand${lo ? ` ${ONES[lo]}` : ''}`;
  return `${under100(hi)} ${lo === 0 ? 'hundred' : lo < 10 ? `oh ${ONES[lo]}` : under100(lo)}`;
}

const MONTHS = /^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?$/;
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

function speakCore(core: string, overrides: Map<string, string>, overridesCI: Map<string, string>, style: AcronymStyle = 'spaced'): string {
  const native = style === 'native';
  if (!core) return core;
  const o = overrides.get(core) ?? overridesCI.get(core.toLowerCase());
  if (o !== undefined) return o;
  if (BUILTIN_LEXICON[core] !== undefined) return restyle(BUILTIN_LEXICON[core], style);
  // Spanish ñ ("Jalapeño") is mangled by the English front end; "ny" keeps the sound.
  if (/ñ/i.test(core)) return core.replace(/ñ/g, 'ny').replace(/Ñ/g, 'Ny');
  let m: RegExpExecArray | null;
  if ((m = /^\$(\d+(?:[.,]\d+)?)([KMBT])?$/.exec(core))) return `${m[1]}${m[2] ? ` ${SCALE[m[2]]}` : ''} dollars`;
  if ((m = /^(\d+(?:\.\d+)?)%$/.exec(core))) return `${m[1]} percent`;
  if ((m = /^(\d+(?:\.\d+)?)[x×]$/i.exec(core))) return `${m[1]} times`;
  if ((m = /^v(\d+(?:\.\d+)*)$/i.exec(core))) return `version ${m[1]}`;
  if ((m = /^(\d+(?:\.\d+)?)([KMBT])$/.exec(core))) return `${m[1]} ${SCALE[m[2]]}`;
  if ((m = /^~(\d.*)$/.exec(core))) return `about ${m[1]}`;
  if (native && /^[A-Z][A-Z0-9]{0,7}s?$|^[A-Z]{2,6}'s$/.test(core)) return core; // the engine's own G2P spells acronyms and model names correctly
  if (WORDLIKE.has(core.replace(/s$/, ''))) return core;
  if (/^[A-Z]{2,6}'s$/.test(core)) return spellAcronym(`${core.slice(0, -2)}s`, style);
  if (/^[A-Z]{2,6}s?$/.test(core)) return spellAcronym(core, style);
  // Hyphenated / compound technical names: map each part ("GPT-4" → "G P T 4", "H100-SXM" → "H100 S X M").
  if (core.includes('-') && /[A-Z]{2}/.test(core)) {
    return core
      .split('-')
      .map((p) => speakCore(p, overrides, overridesCI, style))
      .join(' ');
  }
  // Letter+digit model names: "H100" → "H 100", "A100" → "A 100", "M3" → "M 3".
  if ((m = /^([A-Z]{1,3})(\d{1,4})$/.exec(core))) return `${m[1].split('').join(' ')} ${m[2]}`;
  return core;
}

/** Tokenise narration into (original, spoken) pairs. User overrides win over built-ins. */
export function speechTokens(text: string, overrides: Pronunciation[] = [], opts: { acronyms?: AcronymStyle; /** Say years as words (Piper read "2026" as "two thousand, twenty-six"). */ years?: boolean } = {}): SpeechToken[] {
  const style = opts.acronyms ?? 'spaced';
  const native = style === 'native';
  const exact = new Map(overrides.map((p) => [p.term, p.say]));
  const ci = new Map(overrides.map((p) => [p.term.toLowerCase(), p.say]));
  const words = text.split(/\s+/).filter(Boolean);
  return words.map((orig, i) => {
      const prev = (words[i - 1] ?? '').replace(/[^\p{L}\p{N}.]/gu, '');
      // Spoken dates: "March 3" → "March 3rd".
      const day = /^(\d{1,2})([,.;:!?]?)$/.exec(orig);
      if (day && MONTHS.test(prev) && +day[1] >= 1 && +day[1] <= 31) return { orig, spoken: `${ordinal(+day[1])}${day[2]}` };
      // Product model numbers after a product line are said in pairs: "RTX 5070" → "fifty seventy", "GTX 1080" → "ten eighty".
      const year = opts.years ? /^(1[1-9]\d\d|20\d\d)([,.;:!?]?)$/.exec(orig) : null;
      if (year && !/^(RTX|GTX|RX|GT|Quadro|Radeon|GeForce|Arc)$/.test(prev)) return { orig, spoken: `${yearWords(+year[1])}${year[2]}` };
      const model = /^(\d{2})(\d{2})([,.;:!?]?)$/.exec(orig);
      if (model && !native && /^(RTX|GTX|RX|GT|Quadro|Radeon|GeForce|Arc)$/.test(prev)) return { orig, spoken: `${model[1]} ${model[2] === '00' ? 'hundred' : model[2].replace(/^0/, 'oh ')}${model[3]}` };
      // Whole-token lexicon entries that include punctuation (e.g. "e.g.", "vs.").
      const whole = exact.get(orig) ?? BUILTIN_LEXICON[orig];
      if (whole !== undefined && /[.]$/.test(orig)) return { orig, spoken: whole };
      const m = /^([("'“‘[]*)(.*?)([)"'”’\].,;:!?]*)$/.exec(orig)!;
      const [, lead, core, trail] = m;
      // Typographic apostrophes/quotes are not in Kokoro's lexicon: "Nvidia’s" was heard as "Nvidiya Hafes".
      const plain = (x: string) => x.replace(/[’‘ʼ]/g, "'").replace(/[“”]/g, '"');
      return { orig, spoken: plain(`${lead}${speakCore(plain(core), exact, ci, style)}${trail}`) };
  });
}

export const spokenText = (tokens: SpeechToken[]): string => tokens.map((t) => t.spoken).join(' ');

/** Letters (and digits) a token takes to say, used as a duration weight; pauses add weight at commas. */
export const spokenWeight = (t: SpeechToken): number => {
  const words = t.spoken.split(/\s+/).filter(Boolean);
  // A spelled-out letter ("G" in "G P U") takes about as long as a short word.
  const letters = words.reduce((n, w) => n + (/^\p{L}$/u.test(w.replace(/[^\p{L}]/gu, '')) ? 3 : w.replace(/[^\p{L}\p{N}]/gu, '').length), 0);
  return letters + 2 * words.length + (/[,;:]$/.test(t.orig) ? 3 : 0) + (/\d/.test(t.spoken) ? 2 : 0);
};

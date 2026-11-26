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

/** Spell out an acronym: "GPU" → "G P U", "LLMs" → "L L Ms". */
export function spellAcronym(w: string): string {
  const m = /^([A-Z]{2,6})(s?)$/.exec(w);
  if (!m) return w;
  // A spaced lone "A" is read as the article "a" (verified with Whisper: "A I" → "I"); hyphens keep it a letter ("A-P-I").
  return m[1].split('').join(m[1].includes('A') ? '-' : ' ') + (m[2] ? 's' : '');
}

function speakCore(core: string, overrides: Map<string, string>, overridesCI: Map<string, string>): string {
  if (!core) return core;
  const o = overrides.get(core) ?? overridesCI.get(core.toLowerCase());
  if (o !== undefined) return o;
  if (BUILTIN_LEXICON[core] !== undefined) return BUILTIN_LEXICON[core];
  // Spanish ñ ("Jalapeño") is mangled by the English front end; "ny" keeps the sound.
  if (/ñ/i.test(core)) return core.replace(/ñ/g, 'ny').replace(/Ñ/g, 'Ny');
  let m: RegExpExecArray | null;
  if ((m = /^\$(\d+(?:[.,]\d+)?)([KMBT])?$/.exec(core))) return `${m[1]}${m[2] ? ` ${SCALE[m[2]]}` : ''} dollars`;
  if ((m = /^(\d+(?:\.\d+)?)%$/.exec(core))) return `${m[1]} percent`;
  if ((m = /^(\d+(?:\.\d+)?)[x×]$/i.exec(core))) return `${m[1]} times`;
  if ((m = /^v(\d+(?:\.\d+)*)$/i.exec(core))) return `version ${m[1]}`;
  if ((m = /^(\d+(?:\.\d+)?)([KMBT])$/.exec(core))) return `${m[1]} ${SCALE[m[2]]}`;
  if ((m = /^~(\d.*)$/.exec(core))) return `about ${m[1]}`;
  if (WORDLIKE.has(core.replace(/s$/, ''))) return core;
  if (/^[A-Z]{2,6}s?$/.test(core)) return spellAcronym(core);
  // Hyphenated / compound technical names: map each part ("GPT-4" → "G P T 4", "H100-SXM" → "H100 S X M").
  if (core.includes('-') && /[A-Z]{2}/.test(core)) {
    return core
      .split('-')
      .map((p) => speakCore(p, overrides, overridesCI))
      .join(' ');
  }
  // Letter+digit model names: "H100" → "H 100", "A100" → "A 100", "M3" → "M 3".
  if ((m = /^([A-Z]{1,3})(\d{1,4})$/.exec(core))) return `${m[1].split('').join(' ')} ${m[2]}`;
  return core;
}

/** Tokenise narration into (original, spoken) pairs. User overrides win over built-ins. */
export function speechTokens(text: string, overrides: Pronunciation[] = []): SpeechToken[] {
  const exact = new Map(overrides.map((p) => [p.term, p.say]));
  const ci = new Map(overrides.map((p) => [p.term.toLowerCase(), p.say]));
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((orig) => {
      // Whole-token lexicon entries that include punctuation (e.g. "e.g.", "vs.").
      const whole = exact.get(orig) ?? BUILTIN_LEXICON[orig];
      if (whole !== undefined && /[.]$/.test(orig)) return { orig, spoken: whole };
      const m = /^([("'“‘[]*)(.*?)([)"'”’\].,;:!?]*)$/.exec(orig)!;
      const [, lead, core, trail] = m;
      // Typographic apostrophes/quotes are not in Kokoro's lexicon: "Nvidia’s" was heard as "Nvidiya Hafes".
      const plain = (x: string) => x.replace(/[’‘ʼ]/g, "'").replace(/[“”]/g, '"');
      return { orig, spoken: plain(`${lead}${speakCore(plain(core), exact, ci)}${trail}`) };
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

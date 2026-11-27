/**
 * The fixed voice benchmark. Every engine and voice is judged on exactly this text, so recordings made
 * months apart stay comparable. Do not edit the passages; add a new version instead (and keep the old one).
 */
export const VOICE_BENCHMARK_VERSION = 1;

export interface BenchmarkPassage {
  id: string;
  /** What the passage tests. */
  tests: string;
  text: string;
}

export const VOICE_BENCHMARK: BenchmarkPassage[] = [
  { id: 'short', tests: 'short conversational sentences', text: "Okay, quick one. You've heard the hype. Here's what's real." },
  {
    id: 'long',
    tests: 'one long explanatory sentence with commas',
    text: 'Graphics chips were designed to draw millions of pixels at once, and it turns out that the same kind of simple, repetitive math is exactly what a neural network needs when it learns from data.'
  },
  { id: 'question', tests: 'questions versus statements', text: 'So why does that matter? Because the chip you train on decides what you can afford to build. Does that sound like a small detail? It is not.' },
  {
    id: 'punctuation',
    tests: 'semicolons, colons and a paragraph transition',
    text: 'Training is expensive; running the model is cheaper, but it never stops. There are two costs to watch: the hardware, and the electricity.\n\nNow, let us look at who actually pays for it.'
  },
  {
    id: 'terms',
    tests: 'acronyms, technical terms and names',
    text: 'NVIDIA sells most of the GPUs used for AI, while AMD and Intel are catching up. A GPU is not a CPU; CPUs handle a few tasks quickly, GPUs handle thousands at once. Developers write CUDA code, and an RTX 5070 has 12 gigabytes of VRAM. We track all of it in Omnicore.'
  },
  {
    id: 'numbers',
    tests: 'numbers, dates, money, percentages and abbreviations',
    text: 'On March 3, 2026, the company reported $4.5B in revenue, up 38% from 2025. Dr. Chen said the H100 costs about 3x more than the older A100, e.g. for large training runs.'
  },
  {
    id: 'emphasis',
    tests: 'emphasis and a change of tone',
    text: "This is the part nobody tells you. The model did not get smarter. It got bigger. And honestly? That's both exciting and a little worrying."
  }
];

/** The full benchmark as one narration script (passages are separate paragraphs). */
export const voiceBenchmarkScript = (): string => VOICE_BENCHMARK.map((p) => p.text).join('\n\n');

/** Terms whose pronunciation is checked in every benchmark run, with what a listener should hear. */
export const BENCHMARK_TERMS: { term: string; expect: string; heardAs: RegExp }[] = [
  { term: 'GPU', expect: 'the letters G-P-U', heardAs: /\b(a )?GPU\b(?!s)/i },
  { term: 'GPUs', expect: 'G-P-Us, with the plural', heardAs: /\bGPUs\b|\bGPU's\b/i },
  { term: 'CPU', expect: 'the letters C-P-U', heardAs: /\bCPU\b(?!s)/i },
  { term: 'CPUs', expect: 'C-P-Us, with the plural', heardAs: /\bCPUs\b|\bCPU's\b/i },
  { term: 'NVIDIA', expect: 'en-VID-ee-uh', heardAs: /\bn ?vidia\b/i },
  { term: 'AMD', expect: 'the letters A-M-D', heardAs: /\bAMD\b/i },
  { term: 'CUDA', expect: 'KOO-duh', heardAs: /\bcuda\b|\bkuda\b|\bcooda\b/i },
  { term: 'VRAM', expect: 'VEE-ram', heardAs: /\bv ?-?ram\b|\bvee ?ram\b/i },
  { term: 'RTX 5070', expect: 'R-T-X fifty seventy', heardAs: /\bRTX (5070|50 ?70|fifty)/i },
  { term: 'Omnicore', expect: 'OM-nee-core', heardAs: /\bomni ?-?core\b/i }
];

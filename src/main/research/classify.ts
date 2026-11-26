import type { SourceKind } from '../../shared/production';

/** Organisations whose own sites/newsrooms are company announcements (primary, but self-interested claims). */
const COMPANY: Record<string, string> = {
  'openai.com': 'OpenAI',
  'anthropic.com': 'Anthropic',
  'blog.google': 'Google',
  'ai.google': 'Google',
  'research.google': 'Google Research',
  'deepmind.google': 'Google DeepMind',
  'deepmind.com': 'Google DeepMind',
  'nvidia.com': 'NVIDIA',
  'nvidianews.nvidia.com': 'NVIDIA',
  'blogs.nvidia.com': 'NVIDIA',
  'developer.nvidia.com': 'NVIDIA',
  'amd.com': 'AMD',
  'intel.com': 'Intel',
  'microsoft.com': 'Microsoft',
  'blogs.microsoft.com': 'Microsoft',
  'news.microsoft.com': 'Microsoft',
  'meta.com': 'Meta',
  'ai.meta.com': 'Meta',
  'about.fb.com': 'Meta',
  'apple.com': 'Apple',
  'machinelearning.apple.com': 'Apple',
  'aboutamazon.com': 'Amazon',
  'aws.amazon.com': 'Amazon Web Services',
  'mistral.ai': 'Mistral AI',
  'x.ai': 'xAI',
  'cohere.com': 'Cohere',
  'stability.ai': 'Stability AI',
  'qualcomm.com': 'Qualcomm',
  'arm.com': 'Arm',
  'ibm.com': 'IBM',
  'samsung.com': 'Samsung',
  'tsmc.com': 'TSMC',
  'perplexity.ai': 'Perplexity',
  'ai21.com': 'AI21 Labs',
  'cerebras.ai': 'Cerebras',
  'groq.com': 'Groq'
};

const REPORTING: Record<string, string> = {
  'theverge.com': 'The Verge',
  'arstechnica.com': 'Ars Technica',
  'techcrunch.com': 'TechCrunch',
  'technologyreview.com': 'MIT Technology Review',
  'wired.com': 'Wired',
  'reuters.com': 'Reuters',
  'apnews.com': 'Associated Press',
  'bloomberg.com': 'Bloomberg',
  'ft.com': 'Financial Times',
  'nytimes.com': 'The New York Times',
  'washingtonpost.com': 'The Washington Post',
  'wsj.com': 'The Wall Street Journal',
  'theguardian.com': 'The Guardian',
  'bbc.com': 'BBC',
  'bbc.co.uk': 'BBC',
  'cnbc.com': 'CNBC',
  'venturebeat.com': 'VentureBeat',
  'zdnet.com': 'ZDNET',
  'engadget.com': 'Engadget',
  'tomshardware.com': "Tom's Hardware",
  'anandtech.com': 'AnandTech',
  'theregister.com': 'The Register',
  'axios.com': 'Axios',
  'semafor.com': 'Semafor',
  'theinformation.com': 'The Information',
  '404media.co': '404 Media',
  'spectrum.ieee.org': 'IEEE Spectrum',
  'nature.com': 'Nature',
  'science.org': 'Science',
  'newscientist.com': 'New Scientist',
  'scientificamerican.com': 'Scientific American',
  'servethehome.com': 'ServeTheHome',
  'phoronix.com': 'Phoronix',
  'techradar.com': 'TechRadar',
  'theinformation.co': 'The Information'
};

const RESEARCH_HOSTS = ['arxiv.org', 'doi.org', 'openalex.org', 'aclanthology.org', 'openreview.net', 'proceedings.mlr.press', 'neurips.cc', 'dl.acm.org', 'ieeexplore.ieee.org', 'link.springer.com', 'sciencedirect.com', 'pnas.org', 'biorxiv.org', 'ssrn.com'];
const OFFICIAL_SUFFIX = ['.gov', '.gov.uk', '.gouv.fr', '.europa.eu', '.gc.ca', '.gov.au', '.mil', 'oecd.org', 'un.org', 'iso.org', 'w3.org', 'nist.gov', 'sec.gov', 'federalregister.gov', 'standards.ieee.org', 'ietf.org'];
const COMMUNITY = ['news.ycombinator.com', 'reddit.com', 'x.com', 'twitter.com', 'medium.com', 'substack.com', 'linkedin.com', 'facebook.com', 'youtube.com', 'quora.com', 'stackoverflow.com', 'dev.to', 'hashnode.dev'];

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const matches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const lookup = (host: string, table: Record<string, string>): string | undefined => {
  const exact = table[host];
  if (exact) return exact;
  const k = Object.keys(table).find((d) => matches(host, d));
  return k ? table[k] : undefined;
};

/** Classify a URL into an evidence kind plus a publisher name. Unknown sites are "other", never assumed reputable. */
export function classifyUrl(url: string): { kind: SourceKind; publisher: string } {
  const host = hostOf(url);
  if (!host) return { kind: 'other', publisher: 'Unknown' };
  if (matches(host, 'wikipedia.org')) return { kind: 'background', publisher: 'Wikipedia' };
  if (host === 'github.com' || host === 'huggingface.co') {
    const owner = (() => {
      try {
        return new URL(url).pathname.split('/').filter(Boolean)[0] ?? host;
      } catch {
        return host;
      }
    })();
    if (host === 'huggingface.co' && owner === 'blog') return { kind: 'company', publisher: 'Hugging Face' };
    return { kind: 'official', publisher: owner };
  }
  const company = lookup(host, COMPANY);
  if (company) return { kind: 'company', publisher: company };
  if (OFFICIAL_SUFFIX.some((d) => host === d.replace(/^\./, '') || host.endsWith(d.startsWith('.') ? d : `.${d}`))) return { kind: 'official', publisher: host };
  if (RESEARCH_HOSTS.some((d) => matches(host, d)) || /\.edu$|\.ac\.[a-z]{2}$/.test(host)) return { kind: 'research', publisher: host };
  const press = lookup(host, REPORTING);
  if (press) return { kind: 'reporting', publisher: press };
  if (COMMUNITY.some((d) => matches(host, d))) return { kind: 'community', publisher: host };
  return { kind: 'other', publisher: host };
}

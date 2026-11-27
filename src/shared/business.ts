// Businesses, modules and topics: the multi-business layer shared by main and renderer.

/** Capabilities a business can enable. Only modules marked `available` have working pages today. */
export const MODULES = {
  media: { label: 'Media & publishing', description: 'Research, scripts, video production, rights, publishing and audience analytics.', available: true },
  ecommerce: { label: 'E-commerce', description: 'Products, orders, fulfilment and sales.', available: false },
  saas: { label: 'SaaS & software', description: 'Subscriptions, onboarding, support and churn.', available: false },
  services: { label: 'Services & agency', description: 'Clients, proposals, projects and invoicing.', available: false },
  digital: { label: 'Digital products', description: 'Catalogue, downloads, licensing and sales.', available: false }
} as const;
export type ModuleId = keyof typeof MODULES;
export const isModuleId = (v: unknown): v is ModuleId => typeof v === 'string' && v in MODULES;

/** Business types are starting templates: they choose the initial modules, and everything stays editable. */
export const BUSINESS_TYPES = {
  media: { label: 'Media & publishing', modules: ['media'] as ModuleId[] },
  ecommerce: { label: 'E-commerce store', modules: ['ecommerce'] as ModuleId[] },
  saas: { label: 'SaaS / software', modules: ['saas'] as ModuleId[] },
  services: { label: 'Services / agency', modules: ['services'] as ModuleId[] },
  digital: { label: 'Digital products', modules: ['digital'] as ModuleId[] },
  other: { label: 'Other', modules: [] as ModuleId[] }
} as const;
export type BusinessType = keyof typeof BUSINESS_TYPES;
export const isBusinessType = (v: unknown): v is BusinessType => typeof v === 'string' && v in BUSINESS_TYPES;

export interface Business {
  id: number;
  name: string;
  slug: string;
  /** Short subject focus (used by research and discovery). */
  niche: string;
  platforms: string[];
  createdAt: string;
  businessType: BusinessType;
  modules: ModuleId[];
  description: string;
  objectives: string;
  /** Standing instructions for this business's AI agents (writers, discovery). Never shared with other businesses. */
  instructions: string;
  accent: string;
  archivedAt: string | null;
  presenterEngine?: string;
  presenterVoice?: string;
  editorial?: { keywords?: string[] };
}

export interface BusinessDraft {
  name: string;
  businessType: BusinessType;
  description?: string;
  objectives?: string;
  niche?: string;
  accent?: string;
}

export type BusinessPatch = Partial<Pick<Business, 'name' | 'description' | 'objectives' | 'instructions' | 'niche' | 'accent' | 'modules' | 'businessType'>>;

export interface Topic {
  id: number;
  businessId: number;
  parentId: number | null;
  name: string;
  description: string;
  keywords: string[];
  exclusions: string[];
  /** 1 (highest) … 5 (lowest). */
  priority: number;
  position: number;
  enabled: boolean;
  /** "proposed" topics were suggested by an agent and do nothing until the user accepts them. */
  status: 'active' | 'proposed';
  origin: 'user' | 'agent' | 'seed';
  researchPriority: 'low' | 'normal' | 'high';
  discovery: string;
  objectives: string;
  autonomousOk: boolean;
  approvalRequired: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TopicDraft = Partial<Omit<Topic, 'id' | 'businessId' | 'status' | 'origin' | 'archivedAt' | 'createdAt' | 'updatedAt' | 'position'>> & { name: string };

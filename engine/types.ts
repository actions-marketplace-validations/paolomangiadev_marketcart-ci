// Shared types for the MarketCart CI engine. Erasable TypeScript only (runs on Node >= 22.18 type stripping).

export type Status = 'PASS' | 'REGRESSION' | 'BLOCKED' | 'UNSUPPORTED' | 'ERROR';

export type EvidenceClass = 'synthetic-fixture' | 'live-shopify' | 'live-shopify-injected';

export interface Market {
  country: string; // ISO 3166-1 alpha-2
  currency: string; // ISO 4217
}

export interface RequestedLine {
  url: string; // product URL on an authorized domain, e.g. https://shop.example/products/x?variant=123
  variantId: number;
  quantity: number;
}

export interface CaseChecks {
  badge?: boolean; // default: adapter decides (Dawn declares a badge)
  total?: boolean; // true = required (absent/unreadable/currency-less total => UNSUPPORTED); false = off; omitted = checked when shown
}

export interface CaseSpec {
  id: string;
  adapter: 'dawn';
  market: Market;
  lines: RequestedLine[];
  authorizedDomains: string[];
  evidenceClass: EvidenceClass;
  timeoutMs?: number; // capped at 90_000
  checks?: CaseChecks;
}

export interface PairSpec {
  id: string;
  live: CaseSpec;
  candidate: CaseSpec;
}

export interface StoredLine {
  variantId: number;
  productTitle: string;
  variantTitle: string;
  quantity: number;
  finalLinePriceMinor: number;
}

export interface StoredCart {
  currency: string;
  itemCount: number;
  totalMinor: number;
  lines: StoredLine[];
}

export interface ParsedMoney {
  amountMinor: number | null;
  currencyCandidates: string[];
  error?: string;
}

export interface VisibleLine {
  variantId: number | null;
  title: string;
  options: string[];
  quantity: number | null;
  priceText: string | null;
  parsed?: ParsedMoney;
}

export interface VisibleCart {
  surface: 'drawer' | 'cart-page';
  lines: VisibleLine[];
  badgeCount: number | null; // null = no badge element present
  badgeDeclared: boolean;
  totalText: string | null;
}

export interface MarketObservation {
  verified: boolean;
  observedCountry: string | null;
  observedCurrency: string | null;
  evidence: string;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CostRecord {
  measured: boolean;
  usd: number | 'UNKNOWN';
  basis: string;
}

export interface CaseResult {
  caseId: string;
  kind: 'single' | 'pair';
  engineVersion: string;
  source: { urls: string[]; evidenceClass: EvidenceClass };
  requested: { market: Market; lines: { variantId: number; quantity: number }[] };
  market: MarketObservation | null;
  stored: StoredCart | null;
  visible: VisibleCart | null;
  status: Status;
  reason: string;
  checks: Check[];
  durationMs: number;
  attempts: number;
  cost: CostRecord;
  screenshot: string | null;
  casesConsumed: number; // 1 for single, 2 for a pair
  theme?: { schema: string | null; version: string | null; adapter: string | null; surface: 'drawer' | 'cart-page' | null };
  pacing?: { waitedMs: number; rateLimited: boolean; retryAfterMs: number | null; attemptStarts: string[] };
  parts?: CaseResult[]; // live + candidate for pairs
}

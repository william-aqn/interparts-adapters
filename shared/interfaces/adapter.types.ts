/**
 * adapter.types.ts — central contract for all supplier adapters.
 *
 * This file is the SOURCE OF TRUTH. A copy lives in:
 *   interparts-adapters/shared/interfaces/adapter.types.ts
 *
 * When modifying this file, update the copy in interparts-adapters in the
 * same change (phase 6 will automate this via a GitHub Action PR).
 *
 * Every adapter MUST implement PartSearchAdapter and default-export an
 * object satisfying the interface:
 *
 *   const adapter: PartSearchAdapter = { ... };
 *   export default adapter;
 *
 * See ТЗ §4 for rationale.
 */

// ─── Mode & status enums ─────────────────────────────────────
export type AdapterMode = 'api' | 'http' | 'browser';

export type AvailabilityStatus =
  | 'in_stock'
  | 'on_order'
  | 'out_of_stock'
  | 'unknown';

// ─── Capabilities (declared in adapter.ts) ───────────────────
export interface AdapterCapabilities {
  mode: AdapterMode;
  needsAuth: boolean;
  supportsBulkSearch: boolean;
  maxRPS: number;
  searchByVIN: boolean;
  searchByCross: boolean;
}

// ─── Query / result shapes ───────────────────────────────────
export interface PartQuery {
  partNumber: string;
  brand?: string;
  vin?: string;
  limit?: number;
}

export interface PartResult {
  /** Raw OEM/article number. */
  partNumber: string;
  brand: string;
  name: string;
  price: number;
  /** ISO 4217: RUB, USD, EUR, KZT... */
  currency: string;
  availability: AvailabilityStatus;
  deliveryDays?: number;
  deliveryCity?: string;
  /** Available quantity at source, if known. */
  quantity?: number;
  /** Warehouse / city of shipment. */
  warehouse?: string;
  /** siteId — always set by adapter. */
  source: string;
  /** Direct URL to the product page when available. */
  sourceUrl?: string;
  /** Direct URL to a product or brand thumbnail (for the admin UI). */
  imageUrl?: string;
  updatedAt: Date;
  /** Original unparsed data, for debugging. */
  raw?: Record<string, unknown>;
}

export interface PartDetails extends PartResult {
  images?: string[];
  /** Weight in kg. */
  weight?: number;
  /** Dimensions in mm. */
  dimensions?: { l: number; w: number; h: number };
  /** OEM reference numbers. */
  oem?: string[];
  /** Cross-references / analog part numbers. */
  crossReferences?: string[];
  description?: string;
}

export interface HealthStatus {
  ok: boolean;
  latencyMs: number;
  error?: string;
  checkedAt: Date;
}

export interface SiteCredentials {
  login: string;
  password: string;
  apiKey?: string;
  extra?: Record<string, string>;
}

// ─── Supporting types for ExecutionContext ──────────────────
/**
 * Minimal CookieJar interface. The runtime wires this to tough-cookie
 * or similar; adapters should use it only via ctx.fetch (which sets cookies
 * automatically) or via these methods.
 */
export interface CookieJar {
  getCookieString(url: string): Promise<string>;
  setCookie(cookie: string, url: string): Promise<void>;
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug?(msg: string, ...args: unknown[]): void;
}

/**
 * Cheerio API shape (kept as unknown to avoid forcing adapters to install
 * cheerio if they don't need it). The 'http' and 'browser' runtimes provide
 * parseHtml = cheerio.load.
 */
export type CheerioAPI = unknown;

/**
 * Playwright Page and BrowserContext. Declared as generic 'unknown' so this
 * file has zero runtime dependencies on Playwright. Browser-mode adapters
 * import Playwright types directly in their own code.
 */
export type PlaywrightPage = unknown;
export type PlaywrightBrowserContext = unknown;

// ─── ExecutionContext: runtime handle passed to every adapter call ─
export interface ExecutionContext {
  /** fetch wrapper with proxy, retry, cookie injection already configured. */
  fetch: typeof globalThis.fetch;
  cookies: CookieJar;
  logger: Logger;
  /** Credentials (only present when the adapter declares needsAuth and the site provides them). */
  credentials?: SiteCredentials;

  /** Logical site id. Adapters MUST use this value for PartResult.source so
   *  the same adapter code can back multiple sites. */
  siteId: string;

  /** mode = 'http' | 'browser': returns Cheerio loader for HTML strings. */
  parseHtml?: (html: string) => CheerioAPI;

  /** mode = 'browser': current Playwright page. */
  page?: PlaywrightPage;
  /** mode = 'browser': Playwright context (for advanced adapters). */
  browserContext?: PlaywrightBrowserContext;
}

// ─── The main interface ─────────────────────────────────────
export interface PartSearchAdapter {
  /** Adapter package identity — matches the on-disk directory name. */
  readonly adapterId: string;
  readonly adapterName: string;
  readonly capabilities: AdapterCapabilities;

  /** One-time setup (warm caches, compile regexes, load statics). */
  initialize(ctx: ExecutionContext): Promise<void>;

  /** Optional: perform authentication flow. Called before search when needsAuth=true. */
  authenticate?(ctx: ExecutionContext): Promise<void>;

  /** Core search operation. MUST return at least empty array, never throw on "no results". */
  search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]>;

  /** Optional: fetch a full detail page for a specific part number. */
  getPartDetails?(ctx: ExecutionContext, partNumber: string): Promise<PartDetails>;

  /** Optional: batched stock check. */
  checkAvailability?(
    ctx: ExecutionContext,
    partNumbers: string[]
  ): Promise<Map<string, AvailabilityStatus>>;

  /** Returns liveness + latency. Used by orchestrator scheduler. */
  healthCheck(ctx: ExecutionContext): Promise<HealthStatus>;
}

/**
 * Every adapter module must default-export an object matching PartSearchAdapter.
 * We don't enforce this at compile time from the loader's side (dynamic import
 * returns any), so adapters should use `satisfies PartSearchAdapter` themselves.
 */
export type AdapterModule = { default: PartSearchAdapter };

/**
 * demo-api adapter — phase 2 reference for mode: "api".
 *
 * Hits httpbin.org/json and maps slideshow.slides[] into PartResult[].
 * The point is NOT the data (it's a fixed test payload) but the integration
 * pattern: pure ctx.fetch, JSON parsing, no HTML, no browser, no Cheerio.
 *
 * Security invariants:
 *   - ctx.fetch only (no imported http/fetch/axios/got)
 *   - No process.env, no fs writes, no eval
 *   - Only reaches httpbin.org (declared in meta.json.url)
 */

import type {
  PartSearchAdapter,
  ExecutionContext,
  PartQuery,
  PartResult,
  HealthStatus,
} from '../../shared/interfaces/adapter.types.js';

interface HttpbinSlide {
  title?: string;
  type?: string;
  items?: string[];
}

interface HttpbinJsonResponse {
  slideshow?: {
    title?: string;
    author?: string;
    date?: string;
    slides?: HttpbinSlide[];
  };
}

const BASE_URL = 'https://httpbin.org';
const JSON_ENDPOINT = '/json';
const REQUEST_TIMEOUT_MS = 6000;

async function fetchJson(
  ctx: ExecutionContext,
  path: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await ctx.fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'InterParts-Aggregator/0.2 (demo-api adapter)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

const adapter: PartSearchAdapter = {
  siteId: 'demo-api',
  siteName: 'Demo API (httpbin.org)',

  capabilities: {
    mode: 'api',
    needsAuth: false,
    supportsBulkSearch: false,
    maxRPS: 5,
    searchByVIN: false,
    searchByCross: false,
  },

  async initialize(ctx: ExecutionContext): Promise<void> {
    ctx.logger.info('demo-api: initialize');
  },

  async search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]> {
    const q = query.partNumber?.trim();
    if (!q) {
      ctx.logger.warn('demo-api: empty partNumber');
      return [];
    }

    ctx.logger.info('demo-api: GET', `${BASE_URL}${JSON_ENDPOINT}`);
    const res = await fetchJson(ctx, JSON_ENDPOINT, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      throw new Error(`demo-api: upstream HTTP ${res.status}`);
    }

    const data = (await res.json()) as HttpbinJsonResponse;
    const slides = data.slideshow?.slides ?? [];
    const now = new Date();

    // Synthetic mapping: each slide becomes a "part"
    return slides.map<PartResult>((slide, idx) => ({
      partNumber: `${q.toUpperCase()}-${idx + 1}`,
      brand: data.slideshow?.author ?? 'demo',
      name: slide.title ?? `slide ${idx + 1}`,
      price: 10 + idx * 5, // deterministic demo pricing
      currency: 'USD',
      availability: 'in_stock',
      quantity: Math.max(1, (slide.items?.length ?? 0)),
      source: 'demo-api',
      sourceUrl: `${BASE_URL}${JSON_ENDPOINT}`,
      updatedAt: now,
      raw: { slide, slideIndex: idx },
    }));
  },

  async healthCheck(ctx: ExecutionContext): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      const res = await fetchJson(ctx, '/status/200', 5000);
      const checkedAt = new Date();
      if (!res.ok) {
        return { ok: false, latencyMs: Date.now() - t0, error: `HTTP ${res.status}`, checkedAt };
      }
      return { ok: true, latencyMs: Date.now() - t0, checkedAt };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: new Date(),
      };
    }
  },
};

export default adapter;

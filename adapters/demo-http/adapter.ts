/**
 * demo-http adapter — phase 1 end-to-end smoke test.
 *
 * Hits the public dummyjson.com JSON test API and maps products[] into
 * the standard PartResult[] shape. This is NOT a real supplier — it exists
 * solely to exercise the full pipeline:
 *
 *   BullMQ task → Worker → AdapterLoader → demo-http.search()
 *     → ctx.fetch(dummyjson) → PartResult[] → ResultReporter
 *
 * Real supplier adapters will replace this when phase 2 ships the AdapterRuntime.
 *
 * Security invariants (see CLAUDE.md of this repo):
 *   - Only ctx.fetch (no imported http/fetch/axios/got)
 *   - No process.env usage
 *   - No filesystem writes
 *   - No eval / Function / child_process
 *   - Only reaches dummyjson.com (declared in meta.json.url)
 */

import type {
  PartSearchAdapter,
  ExecutionContext,
  PartQuery,
  PartResult,
  HealthStatus,
  AvailabilityStatus,
} from '../../shared/interfaces/adapter.types.js';

// dummyjson response shape (only the fields we consume)
interface DummyProduct {
  id: number;
  title: string;
  description: string;
  price: number;
  brand?: string;
  category?: string;
  stock?: number;
  rating?: number;
  thumbnail?: string;
  sku?: string;
}

interface DummySearchResponse {
  products: DummyProduct[];
  total: number;
  skip: number;
  limit: number;
}

const BASE_URL = 'https://dummyjson.com';
const SEARCH_PATH = '/products/search';
const REQUEST_TIMEOUT_MS = 8000;

function mapAvailability(stock: number | undefined): AvailabilityStatus {
  if (stock === undefined) return 'unknown';
  if (stock > 0) return 'in_stock';
  return 'out_of_stock';
}

async function fetchWithTimeout(
  ctx: ExecutionContext,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await ctx.fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'InterParts-Aggregator/0.1 (demo-http adapter)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

const adapter: PartSearchAdapter = {
  siteId: 'demo-http',
  siteName: 'Demo HTTP (dummyjson.com)',

  capabilities: {
    mode: 'http',
    needsAuth: false,
    supportsBulkSearch: false,
    maxRPS: 5,
    searchByVIN: false,
    searchByCross: false,
  },

  async initialize(ctx: ExecutionContext): Promise<void> {
    ctx.logger.info('demo-http: initialize');
  },

  async search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]> {
    const q = query.partNumber?.trim();
    if (!q) {
      ctx.logger.warn('demo-http: empty partNumber, returning []');
      return [];
    }

    const limit = Math.min(Math.max(query.limit ?? 10, 1), 30);
    const url = `${BASE_URL}${SEARCH_PATH}?q=${encodeURIComponent(q)}&limit=${limit}`;

    ctx.logger.info('demo-http: GET', url);
    const res = await fetchWithTimeout(ctx, url, REQUEST_TIMEOUT_MS);

    if (!res.ok) {
      ctx.logger.warn('demo-http: HTTP non-OK', res.status);
      if (res.status === 404) return [];
      throw new Error(`demo-http: upstream HTTP ${res.status}`);
    }

    const data = (await res.json()) as DummySearchResponse;
    if (!Array.isArray(data.products)) {
      ctx.logger.warn('demo-http: unexpected response shape', { hasProducts: false });
      return [];
    }

    const now = new Date();
    return data.products.map<PartResult>((p) => ({
      partNumber: String(p.sku ?? p.id),
      brand: p.brand ?? 'unknown',
      name: p.title,
      price: Number.isFinite(p.price) ? p.price : 0,
      currency: 'USD',
      availability: mapAvailability(p.stock),
      ...(p.stock !== undefined && { quantity: p.stock }),
      source: 'demo-http',
      sourceUrl: `${BASE_URL}/products/${p.id}`,
      updatedAt: now,
      raw: {
        id: p.id,
        category: p.category,
        rating: p.rating,
        description: p.description,
      },
    }));
  },

  async healthCheck(ctx: ExecutionContext): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      const res = await fetchWithTimeout(ctx, `${BASE_URL}/products/1`, 5000);
      const ok = res.ok;
      const checkedAt = new Date();
      if (!ok) {
        return {
          ok: false,
          latencyMs: Date.now() - t0,
          error: `HTTP ${res.status}`,
          checkedAt,
        };
      }
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        checkedAt,
      };
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

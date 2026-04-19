/**
 * demo-browser adapter — phase 2 reference for mode: "browser".
 *
 * Navigates quotes.toscrape.com/tag/<query>/ with Playwright, scrapes quote
 * blocks. Authors become "brand", quote text becomes "name". It's a fixture —
 * the numbers (price, quantity) are synthetic because the fixture has no
 * commerce data.
 *
 * Demonstrates the browser-mode API surface:
 *   - ctx.page.goto(...)
 *   - ctx.page.$$('.quote') selector queries
 *   - combining Playwright with Cheerio via ctx.parseHtml(html)
 *
 * Security invariants:
 *   - Only ctx.page / ctx.parseHtml / ctx.fetch (no direct Playwright import)
 *   - Only reaches quotes.toscrape.com (declared in meta.json.url)
 */

import type {
  PartSearchAdapter,
  ExecutionContext,
  PartQuery,
  PartResult,
  HealthStatus,
} from '../../shared/interfaces/adapter.types.js';

const BASE_URL = 'https://quotes.toscrape.com';

interface PlaywrightPageLike {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
}

function pageAsPlaywright(ctx: ExecutionContext): PlaywrightPageLike {
  if (!ctx.page) {
    throw new Error('demo-browser: ExecutionContext.page missing — worker must run in browser mode');
  }
  return ctx.page as PlaywrightPageLike;
}

const adapter: PartSearchAdapter = {
  adapterId: 'demo-browser',
  adapterName: 'Demo Browser (quotes.toscrape.com)',

  capabilities: {
    mode: 'browser',
    needsAuth: false,
    supportsBulkSearch: false,
    maxRPS: 2,
    searchByVIN: false,
    searchByCross: false,
  },

  async initialize(ctx: ExecutionContext): Promise<void> {
    ctx.logger.info('demo-browser: initialize');
  },

  async search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]> {
    const q = query.partNumber?.trim();
    if (!q) {
      ctx.logger.warn('demo-browser: empty partNumber');
      return [];
    }

    const page = pageAsPlaywright(ctx);
    const targetUrl = `${BASE_URL}/tag/${encodeURIComponent(q.toLowerCase())}/`;

    ctx.logger.info('demo-browser: goto', targetUrl);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });

    const html = await page.content();
    if (!ctx.parseHtml) {
      throw new Error('demo-browser: ctx.parseHtml missing');
    }
    const $ = ctx.parseHtml(html) as ReturnType<typeof import('cheerio').load>;

    const now = new Date();
    const results: PartResult[] = [];

    $('.quote').each((idx, el) => {
      const $el = $(el);
      const author = $el.find('small.author').first().text().trim() || 'unknown';
      const text = $el.find('span.text').first().text().trim();
      const tags = $el.find('.tags .tag').map((_, t) => $(t).text().trim()).get();

      results.push({
        partNumber: `${q.toUpperCase()}-${idx + 1}`,
        brand: author,
        name: text.slice(0, 200),
        price: 1 + idx * 2,
        currency: 'USD',
        availability: 'in_stock',
        quantity: tags.length,
        source: ctx.siteId,
        sourceUrl: page.url(),
        updatedAt: now,
        raw: { tags },
      });
    });

    ctx.logger.info('demo-browser: scraped', { count: results.length, url: targetUrl });
    return results;
  },

  async healthCheck(ctx: ExecutionContext): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      // Use ctx.fetch for health (cheap, no browser required for liveness probe)
      const res = await ctx.fetch(BASE_URL, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
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

/**
 * ebay adapter — http-mode, no auth.
 *
 * Hits https://www.ebay.com/sch/i.html?_nkw=<query> and parses the rendered
 * SRP. Each result is a <li class="s-card"> inside <ul class="srp-results">.
 *
 * Gotchas:
 *   - eBay is fronted by Akamai Bot Manager. From a plain datacenter IP
 *     (our Docker egress) the endpoint returns the "Pardon Our Interruption"
 *     splash (~13 KB, zero s-card elements) regardless of User-Agent. This
 *     adapter relies on the site being configured with a residential proxy
 *     (socks5/http) in admin → Proxies, and on the worker's fetch-client
 *     routing ctx.fetch through it. When the splash page comes back we
 *     detect it and return [] with a WARN log so the operator can check
 *     the pool.
 *   - Promo / placement cards have title "Shop on eBay" and a fake
 *     data-listingid — they must be filtered out.
 *   - When there are no real matches, the page still renders a suggestion
 *     grid. The presence of a .srp-save-null-search banner ("No exact
 *     matches found") is the authoritative empty-result signal.
 *   - Card titles wrap an a11y span "Opens in a new window or tab"; strip it.
 *   - Currency depends on visitor geolocation/cookies — parse the symbol
 *     from the rendered price and map to ISO 4217.
 *   - Listing URLs are obfuscated with tracking params; reconstruct a
 *     clean per-item URL from the data-listingid attribute.
 *
 * Security invariants:
 *   - Only touches www.ebay.com (meta.url).
 *   - No auth, no credentials.
 *   - HTTP strictly via ctx.fetch (no direct http / node-fetch import).
 */

import type {
  PartSearchAdapter,
  ExecutionContext,
  PartQuery,
  PartResult,
  HealthStatus,
  AvailabilityStatus,
} from '../../shared/interfaces/adapter.types.js';

const BASE_URL = 'https://www.ebay.com';
const SEARCH_PATH = '/sch/i.html';

/** Desktop Chrome UA. eBay serves the bot-wall splash to requests with a
 *  Node/undici default UA; a browser-like UA is required even when going
 *  through a residential proxy. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CheerioLoader {
  (selector: string): CheerioNode;
}
interface CheerioNode {
  length: number;
  each(fn: (i: number, el: unknown) => void): void;
  find(sel: string): CheerioNode;
  first(): CheerioNode;
  text(): string;
  attr(name: string): string | undefined;
  html(): string | null;
}

function loadCheerio(ctx: ExecutionContext, html: string): CheerioLoader {
  if (!ctx.parseHtml) {
    throw new Error('ebay: ctx.parseHtml is missing — worker must run in http mode');
  }
  return ctx.parseHtml(html) as unknown as CheerioLoader;
}

/** Collapse runs of whitespace and trim. */
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** Strip the a11y "Opens in a new window or tab" trailer present in every
 *  eBay card title. */
function cleanTitle(raw: string): string {
  return norm(raw).replace(/\s*Opens in a new window or tab\s*$/i, '').trim();
}

/** Map the currency symbol / code present in an eBay price string
 *  (e.g. "US $12.99", "AU $25.00", "£9.99", "€14.50", "C $19.00") to an
 *  ISO 4217 code. Default to USD when nothing matches. */
function detectCurrency(priceText: string): string {
  const t = priceText;
  if (/\bAU\s*\$/i.test(t)) return 'AUD';
  if (/\bNZ\s*\$/i.test(t)) return 'NZD';
  if (/\bCA\s*\$/i.test(t) || /\bC\s*\$/i.test(t) || /\bCAD\b/i.test(t)) return 'CAD';
  if (/\bHK\s*\$/i.test(t)) return 'HKD';
  if (/\bSG\s*\$/i.test(t)) return 'SGD';
  if (/\bMX\s*\$/i.test(t) || /\bMXN\b/i.test(t)) return 'MXN';
  if (t.includes('€') || /\bEUR\b/i.test(t)) return 'EUR';
  if (t.includes('£') || /\bGBP\b/i.test(t)) return 'GBP';
  if (t.includes('¥') || /\bJPY\b/i.test(t)) return 'JPY';
  if (/\bCHF\b/i.test(t)) return 'CHF';
  if (/\bPLN\b/i.test(t)) return 'PLN';
  if (t.includes('$') || /\bUS\s*\$/i.test(t) || /\bUSD\b/i.test(t)) return 'USD';
  return 'USD';
}

/** Extract the first numeric amount from an eBay price string. Handles
 *  "$10.00", "US $1,234.56", "$10.00 to $20.00" (picks the lower bound).
 *  Returns 0 when no digits. */
function parseAmount(text: string | null | undefined): number {
  if (!text) return 0;
  const m = text.match(/[\d][\d,]*(?:\.\d+)?/);
  if (!m) return 0;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Pick the best available image URL for an eBay card. The gallery image may
 *  be lazy-loaded (src = placeholder, real URL in data-defer-load or data-src). */
function pickImage(imgEl: CheerioNode): string | undefined {
  const attrs = [
    imgEl.attr('src'),
    imgEl.attr('data-defer-load'),
    imgEl.attr('data-src'),
  ];
  for (const a of attrs) {
    const v = (a ?? '').trim();
    if (!v) continue;
    // eBay lazy-placeholder is a static logo on ir.ebaystatic.com — skip it
    // when a real image URL is available.
    if (/ir\.ebaystatic\.com/.test(v)) continue;
    if (/^https?:\/\//i.test(v)) return v;
  }
  const fallback = (imgEl.attr('src') ?? '').trim();
  return fallback || undefined;
}

function availabilityFor(price: number): AvailabilityStatus {
  return price > 0 ? 'in_stock' : 'unknown';
}

const adapter: PartSearchAdapter = {
  adapterId: 'ebay',
  adapterName: 'eBay',

  capabilities: {
    mode: 'http',
    needsAuth: false,
    supportsBulkSearch: false,
    maxRPS: 2,
    searchByVIN: false,
    searchByCross: false,
  },

  async initialize(ctx: ExecutionContext): Promise<void> {
    ctx.logger.info('ebay: initialize');
  },

  async search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]> {
    const q = query.partNumber?.trim();
    if (!q) return [];

    const url = BASE_URL + SEARCH_PATH + '?_nkw=' + encodeURIComponent(q);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    let html: string;
    try {
      const res = await ctx.fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
      });
      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error('ebay: upstream HTTP ' + res.status);
      }
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }

    // Akamai bot-wall splash: short HTML with "Pardon Our Interruption". The
    // real SRP is ~500 KB; the splash is ~13 KB. Either signal is enough.
    if (html.length < 40_000 && /Pardon Our Interruption|splashui\/challenge/i.test(html)) {
      ctx.logger.warn('ebay: bot-wall splash received (check proxy pool has a residential egress)', {
        htmlBytes: html.length,
      });
      return [];
    }

    const $ = loadCheerio(ctx, html);

    // "No exact matches found" banner → the page still renders suggestions,
    // which are NOT real matches. Treat as empty.
    if ($('.srp-save-null-search').length > 0) {
      ctx.logger.info('ebay: no exact matches', { query: q });
      return [];
    }

    const rows = $('li.s-card');
    if (rows.length === 0) {
      ctx.logger.warn('ebay: zero cards rendered', {
        query: q,
        htmlBytes: html.length,
      });
      return [];
    }

    const limit = Math.max(query.limit ?? Number.POSITIVE_INFINITY, 1);
    const now = new Date();
    const results: PartResult[] = [];

    rows.each((_i, el) => {
      if (results.length >= limit) return;
      const row = $(el as never) as unknown as CheerioNode;

      const rawTitle = row.find('.s-card__title').first().text();
      const title = cleanTitle(rawTitle);
      if (!title || title === 'Shop on eBay') return;

      const listingId = norm(row.attr('data-listingid') ?? '');
      if (!listingId) return;

      const priceText = norm(row.find('.s-card__price').first().text());
      const price = parseAmount(priceText);
      const currency = detectCurrency(priceText);

      const condition = norm(row.find('.s-card__subtitle').first().text());

      const imgEl = row.find('img').first();
      const imageUrl = pickImage(imgEl);

      const sourceUrl = BASE_URL + '/itm/' + encodeURIComponent(listingId);

      const out: PartResult = {
        partNumber: listingId,
        brand: 'unknown',
        name: title,
        price,
        currency,
        availability: availabilityFor(price),
        source: ctx.siteId,
        sourceUrl,
        updatedAt: now,
      };
      if (imageUrl) out.imageUrl = imageUrl;
      if (condition) out.raw = { condition };
      results.push(out);
    });

    ctx.logger.info('ebay: search done', {
      query: q,
      rows: rows.length,
      kept: results.length,
    });
    return results;
  },

  async healthCheck(ctx: ExecutionContext): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      const res = await ctx.fetch(BASE_URL + '/', {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
      });
      const checkedAt = new Date();
      if (!res.ok) {
        return {
          ok: false,
          latencyMs: Date.now() - t0,
          error: 'HTTP ' + res.status,
          checkedAt,
        };
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

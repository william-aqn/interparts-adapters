/**
 * rockauto adapter — http-mode, no auth.
 *
 * Search endpoint: GET https://www.rockauto.com/en/partsearch/?partnum=<num>
 * Response is a full server-rendered HTML page; each result is a
 *   tbody.listing-inner
 * inside a #listingcontainer[N] element.
 *
 * Content-Type declares ISO-8859-1 but the body actually uses Windows-1252
 * codepoints (notably 0x80 for the Euro sign). We therefore decode the
 * raw bytes with TextDecoder('windows-1252') before handing to Cheerio.
 *
 * Security invariants:
 *   - Only touches www.rockauto.com (meta.url).
 *   - No auth, no credentials.
 *   - HTTP strictly via ctx.fetch.
 */

import type {
  PartSearchAdapter,
  ExecutionContext,
  PartQuery,
  PartResult,
  HealthStatus,
  AvailabilityStatus,
  CheerioAPI,
} from '../../shared/interfaces/adapter.types.js';

const BASE_URL = 'https://www.rockauto.com';
const SEARCH_PATH = '/en/partsearch/';

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
    throw new Error('rockauto: ctx.parseHtml is missing — worker must run in http mode');
  }
  const $ = ctx.parseHtml(html) as unknown as CheerioLoader;
  return $;
}

/** Decode RockAuto's response body. They declare ISO-8859-1 but use
 *  Windows-1252 (so 0x80 is €, not a C1 control). Calling response.text()
 *  would follow the declared charset and emit U+0080 for €. */
async function decodeBody(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  return new TextDecoder('windows-1252').decode(buf);
}

/** Map the currency symbol / code present in a RockAuto price string
 *  (e.g. "(€1.33/Each)", "$1.33", "AU$1.33", "CAD$...", "£1.33") to an
 *  ISO 4217 code. If we can't recognise the symbol, return ''. */
function detectCurrency(priceText: string): string {
  const t = priceText;
  if (/AU\$/i.test(t)) return 'AUD';
  if (/NZ\$/i.test(t)) return 'NZD';
  if (/CAD\$/i.test(t) || /CA\$/.test(t)) return 'CAD';
  if (/CLP\$/i.test(t)) return 'CLP';
  if (/MX\$/i.test(t)) return 'MXN';
  if (t.includes('€') || t.includes('\u0080')) return 'EUR';
  if (t.includes('£')) return 'GBP';
  if (t.includes('¥') || t.includes('\u00a5')) return 'JPY';
  if (t.includes('$')) return 'USD';
  return '';
}

/** Extract a numeric amount from a RockAuto price string. Handles forms
 *  like "€1.33", "$1,234.56", "(€1.33/Each)". Returns 0 when no digits. */
function parseAmount(text: string | null | undefined): number {
  if (!text) return 0;
  const cleaned = text.replace(/[^0-9.,-]/g, '');
  if (!cleaned) return 0;
  // RockAuto always uses '.' as the decimal separator; commas are thousands.
  const normalised = cleaned.replace(/,/g, '');
  const n = Number(normalised);
  return Number.isFinite(n) ? n : 0;
}

/** Collapse runs of whitespace and trim. */
function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** RockAuto image src is a site-relative path (e.g. "/info/224/W163C__ra_m.jpg").
 *  Return an absolute URL, or undefined when there is no src. */
function absoluteImage(src: string | null | undefined): string | undefined {
  if (!src) return undefined;
  const s = src.trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) return BASE_URL + s;
  return undefined;
}

const adapter: PartSearchAdapter = {
  adapterId: 'rockauto',
  adapterName: 'RockAuto',

  capabilities: {
    mode: 'http',
    needsAuth: false,
    supportsBulkSearch: false,
    maxRPS: 2,
    searchByVIN: false,
    searchByCross: false,
  },

  async initialize(ctx: ExecutionContext): Promise<void> {
    ctx.logger.info('rockauto: initialize');
  },

  async search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]> {
    const q = query.partNumber?.trim();
    if (!q) return [];

    const url = BASE_URL + SEARCH_PATH + '?partnum=' + encodeURIComponent(q);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    let html: string;
    try {
      const res = await ctx.fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.8',
        },
      });
      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error('rockauto: upstream HTTP ' + res.status);
      }
      html = await decodeBody(res);
    } finally {
      clearTimeout(timer);
    }

    const $ = loadCheerio(ctx, html);
    const rows = $('tbody.listing-inner');
    if (rows.length === 0) {
      ctx.logger.info('rockauto: no parts found', { query: q });
      return [];
    }

    const limit = Math.max(query.limit ?? Number.POSITIVE_INFINITY, 1);
    const now = new Date();
    const results: PartResult[] = [];

    rows.each((_i, el) => {
      if (results.length >= limit) return;
      const row = $(el as never) as unknown as CheerioNode;

      const brand = norm(row.find('.listing-final-manufacturer').first().text());
      const partNumber = norm(row.find('.listing-final-partnumber').first().text());
      if (!partNumber) return;

      const unitPriceText = norm(
        row.find('span.ra-formatted-amount.listing-price').first().text(),
      );
      const totalPriceText = norm(
        row.find('span.ra-formatted-amount.listing-total').first().text(),
      );
      const priceSource = unitPriceText || totalPriceText;
      const currency = detectCurrency(priceSource);
      const price = parseAmount(unitPriceText || totalPriceText);

      const description = norm(
        row
          .find('.listing-text-row-moreinfo-truck .span-link-underline-remover')
          .first()
          .text(),
      );
      const category = norm(row.find('.listing-footnote-text').first().text());
      const name = description || category || partNumber;

      const moreInfoHref = row.find('a.ra-btn-moreinfo').first().attr('href');
      const sourceUrl = moreInfoHref && /^https?:\/\//i.test(moreInfoHref)
        ? moreInfoHref
        : url;

      const imageAttr =
        row.find('img.listing-inline-image-thumb').first().attr('src') ||
        row.find('img.listing-inline-image').first().attr('src');
      const imageUrl = absoluteImage(imageAttr);

      const addToCartVisible =
        row.find('[id^="vew_btnaddtocart"]:not(.ra-hide)').length > 0;
      const notifyOOSVisible =
        row.find('[id^="vew_btnnotifyoos"]:not(.ra-hide)').length > 0;
      const availability: AvailabilityStatus = notifyOOSVisible
        ? 'out_of_stock'
        : addToCartVisible || price > 0
          ? 'in_stock'
          : 'unknown';

      const oemRaw = row
        .find('span[title^="Replaces these Alternate"]')
        .first()
        .text();
      const crossNumbers = oemRaw
        ? oemRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];

      const out: PartResult = {
        partNumber,
        brand: brand || 'unknown',
        name,
        price,
        currency: currency || 'USD',
        availability,
        source: ctx.siteId,
        sourceUrl,
        updatedAt: now,
      };
      if (category && category !== name) {
        out.raw = { category };
      }
      if (crossNumbers.length > 0) {
        out.raw = { ...(out.raw ?? {}), crossNumbers };
      }
      if (imageUrl) out.imageUrl = imageUrl;
      results.push(out);
    });

    ctx.logger.info('rockauto: search done', {
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
      const body = await res.text();
      const ok = /ALL THE PARTS YOUR CAR WILL EVER NEED/i.test(body);
      return {
        ok,
        latencyMs: Date.now() - t0,
        ...(ok ? {} : { error: 'unexpected homepage content' }),
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

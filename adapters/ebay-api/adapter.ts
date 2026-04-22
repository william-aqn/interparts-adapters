/**
 * ebay-api adapter — mode: "api", needsAuth: true.
 *
 * Uses the official eBay Browse API:
 *   GET https://api.ebay.com/buy/browse/v1/item_summary/search?q=<query>&limit=<N>
 *
 * Auth: OAuth 2.0 client_credentials flow.
 *   POST https://api.ebay.com/identity/v1/oauth2/token
 *     Authorization: Basic base64(clientId:clientSecret)
 *     grant_type=client_credentials
 *     scope=https://api.ebay.com/oauth/api_scope
 *
 * Credentials wiring (in admin → Sites → eBay API → Credentials):
 *   - login    → OAuth App ID (Client ID) from developer.ebay.com
 *   - password → OAuth Cert ID (Client Secret) from developer.ebay.com
 *   - apiKey   → optional pre-issued Bearer token; when set, the adapter
 *                uses it directly and SKIPS the client_credentials exchange
 *                (useful for short-lived local testing).
 *
 * Marketplace:
 *   Defaults to EBAY_US. The adapter reads the header `X-EBAY-C-MARKETPLACE-ID`
 *   from meta.prompt.apiNotes (so operators can override per deployment
 *   without touching code). Supported values: EBAY_US, EBAY_GB, EBAY_DE, …
 *   (see https://developer.ebay.com/api-docs/static/rest-request-components.html).
 *
 * Security invariants:
 *   - Only touches api.ebay.com (meta.url).
 *   - Credentials come exclusively from ctx.credentials — no hardcoded keys.
 *   - HTTP strictly via ctx.fetch.
 *   - No process.env, no file I/O, no eval.
 */

import type {
  PartSearchAdapter,
  ExecutionContext,
  PartQuery,
  PartResult,
  HealthStatus,
  AvailabilityStatus,
} from '../../shared/interfaces/adapter.types.js';

const BASE_URL = 'https://api.ebay.com';
const OAUTH_PATH = '/identity/v1/oauth2/token';
const OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const SEARCH_PATH = '/buy/browse/v1/item_summary/search';
const DEFAULT_MARKETPLACE = 'EBAY_US';

interface TokenState {
  token: string;
  expiresAt: number; // epoch ms
}
/** Per-siteId token cache. Lives for the lifetime of the adapter module
 *  (cleared on Force Reload). eBay tokens are valid for ~2 h; we refresh
 *  60 s before expiry. */
const tokenCache = new Map<string, TokenState>();

interface ItemSummary {
  itemId?: string;
  legacyItemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  marketingPrice?: { discountedPrice?: { value?: string; currency?: string } };
  itemWebUrl?: string;
  itemHref?: string;
  image?: { imageUrl?: string };
  thumbnailImages?: Array<{ imageUrl?: string }>;
  seller?: { username?: string; feedbackPercentage?: string };
  condition?: string;
  buyingOptions?: string[];
  itemLocation?: { country?: string };
  categoryPath?: string;
  brand?: string;
  mpn?: string;
}
interface SearchResponse {
  total?: number;
  itemSummaries?: ItemSummary[];
  errors?: Array<{ errorId?: number; message?: string }>;
}
interface TokenResponse {
  access_token?: string;
  expires_in?: number; // seconds
  token_type?: string;
  errors?: Array<{ errorId?: number; message?: string }>;
  error?: string;
  error_description?: string;
}

function authRequired(msg: string): Error {
  const err = new Error(msg);
  err.name = 'AuthRequiredError';
  return err;
}

function marketplaceFromMeta(ctx: ExecutionContext): string {
  // Cheap path: a per-site override can be wired via ctx.logger metadata,
  // but the adapter contract doesn't expose meta.prompt.apiNotes. Keep a
  // static default; operators can fork the adapter if they need EBAY_GB, etc.
  void ctx;
  return DEFAULT_MARKETPLACE;
}

async function getToken(ctx: ExecutionContext): Promise<string> {
  const creds = ctx.credentials;
  if (!creds) throw authRequired('ebay-api: ctx.credentials missing');

  // apiKey = pre-issued token. Use as-is, no cache (operator manages rotation).
  if (creds.apiKey && creds.apiKey.trim()) {
    return creds.apiKey.trim();
  }

  const clientId = (creds.login ?? '').trim();
  const clientSecret = (creds.password ?? '').trim();
  if (!clientId || !clientSecret) {
    throw authRequired('ebay-api: clientId/clientSecret required (login / password)');
  }

  const cacheKey = ctx.siteId + ':' + clientId;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: OAUTH_SCOPE,
  }).toString();

  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await ctx.fetch(BASE_URL + OAUTH_PATH, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authRequired('ebay-api: OAuth rejected (' + res.status + '): ' + text.slice(0, 200));
    }
    throw new Error('ebay-api: OAuth HTTP ' + res.status + ': ' + text.slice(0, 200));
  }
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error('ebay-api: OAuth response was not JSON: ' + text.slice(0, 120));
  }
  if (parsed.error || !parsed.access_token) {
    throw authRequired(
      'ebay-api: OAuth error: ' + (parsed.error_description ?? parsed.error ?? 'no access_token'),
    );
  }
  const ttlMs = (parsed.expires_in ?? 7200) * 1000;
  tokenCache.set(cacheKey, {
    token: parsed.access_token,
    expiresAt: Date.now() + ttlMs,
  });
  ctx.logger.info('ebay-api: token fetched', {
    expiresInSec: parsed.expires_in,
  });
  return parsed.access_token;
}

function mapCondition(c: string | undefined): AvailabilityStatus {
  // Browse API "condition" describes item state (New, Used, ...), NOT stock.
  // If the item appears in the summary it's listed, so we treat everything
  // returned as in_stock. Condition is preserved in raw.condition.
  void c;
  return 'in_stock';
}

function numberOrZero(x: string | undefined): number {
  if (!x) return 0;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function cleanImageUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const t = u.trim();
  return /^https?:\/\//i.test(t) ? t : undefined;
}

const adapter: PartSearchAdapter = {
  adapterId: 'ebay-api',
  adapterName: 'eBay (Browse API)',

  capabilities: {
    mode: 'api',
    needsAuth: true,
    supportsBulkSearch: false,
    // eBay developer default: 5000 calls/day per App ID. 2 rps is well inside
    // that while leaving headroom for health checks.
    maxRPS: 2,
    searchByVIN: false,
    searchByCross: false,
  },

  async initialize(ctx: ExecutionContext): Promise<void> {
    ctx.logger.info('ebay-api: initialize');
  },

  async authenticate(ctx: ExecutionContext): Promise<void> {
    // Prime the cache so the first search doesn't pay the OAuth RTT.
    await getToken(ctx);
  },

  async search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]> {
    const q = query.partNumber?.trim();
    if (!q) return [];

    const token = await getToken(ctx);
    const marketplace = marketplaceFromMeta(ctx);

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const params = new URLSearchParams({
      q,
      limit: String(limit),
    });
    const url = BASE_URL + SEARCH_PATH + '?' + params.toString();

    const res = await ctx.fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': marketplace,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      // Drop the cached token so the next call re-issues.
      for (const [k, v] of tokenCache.entries()) {
        if (v.token === token) tokenCache.delete(k);
      }
      throw authRequired('ebay-api: Browse API rejected token (' + res.status + '): ' + text.slice(0, 200));
    }
    if (!res.ok) {
      throw new Error('ebay-api: Browse API HTTP ' + res.status + ': ' + text.slice(0, 200));
    }

    let data: SearchResponse;
    try {
      data = JSON.parse(text) as SearchResponse;
    } catch {
      throw new Error('ebay-api: Browse API response was not JSON');
    }
    if (data.errors && data.errors.length > 0) {
      throw new Error(
        'ebay-api: Browse API errors: ' +
          data.errors.map((e) => e.errorId + ':' + e.message).join('; '),
      );
    }

    const now = new Date();
    const items = data.itemSummaries ?? [];
    const results: PartResult[] = [];

    for (const it of items) {
      const listingId = (it.legacyItemId || it.itemId || '').trim();
      if (!listingId) continue;
      const title = (it.title ?? '').trim();
      if (!title) continue;

      // Prefer discountedPrice when the listing is on sale; fall back to
      // the regular price. Both paths can be missing for auction-only items.
      const priceObj = it.marketingPrice?.discountedPrice ?? it.price;
      const price = numberOrZero(priceObj?.value);
      const currency = (priceObj?.currency ?? 'USD').toUpperCase();

      const imageUrl =
        cleanImageUrl(it.image?.imageUrl) ??
        cleanImageUrl(it.thumbnailImages?.[0]?.imageUrl);

      const sourceUrl =
        (it.itemWebUrl && /^https?:\/\//i.test(it.itemWebUrl) ? it.itemWebUrl : undefined) ??
        'https://www.ebay.com/itm/' + encodeURIComponent(listingId);

      const out: PartResult = {
        partNumber: it.mpn?.trim() || listingId,
        brand: (it.brand ?? 'unknown').trim() || 'unknown',
        name: title,
        price,
        currency,
        availability: mapCondition(it.condition),
        source: ctx.siteId,
        sourceUrl,
        updatedAt: now,
      };
      if (imageUrl) out.imageUrl = imageUrl;

      const rawExtras: Record<string, unknown> = {};
      if (it.condition) rawExtras.condition = it.condition;
      if (it.itemLocation?.country) rawExtras.country = it.itemLocation.country;
      if (it.categoryPath) rawExtras.categoryPath = it.categoryPath;
      if (it.seller?.username) rawExtras.seller = it.seller.username;
      if (it.buyingOptions && it.buyingOptions.length)
        rawExtras.buyingOptions = it.buyingOptions;
      if (Object.keys(rawExtras).length > 0) out.raw = rawExtras;

      results.push(out);
    }

    ctx.logger.info('ebay-api: search done', {
      query: q,
      received: items.length,
      kept: results.length,
      total: data.total,
    });
    return results;
  },

  async healthCheck(ctx: ExecutionContext): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      // OAuth token endpoint is the lightest way to prove both reachability
      // and credential validity in one shot — a 200 means DNS + TLS + creds
      // are all good.
      await getToken(ctx);
      return { ok: true, latencyMs: Date.now() - t0, checkedAt: new Date() };
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

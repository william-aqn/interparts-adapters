/**
 * worldpac-speeddial adapter — browser-mode.
 *
 * speedDIAL 2.0 is a React SPA that requires user login. The adapter:
 *   1. navigates to /#/login, overwrites the (often pre-filled) username/password
 *      inputs via native value setter + input/change events so React state syncs,
 *      then clicks submit and waits for the URL to leave /#/login.
 *   2. on search, fills the persistent top-bar input #searchTerm, dispatches Enter,
 *      waits for /#/pna to settle, and scrapes .product-quote cards.
 *
 * Security invariants:
 *   - Only reaches speeddial.worldpac.com (meta.url).
 *   - Credentials come from ctx.credentials; never hardcoded.
 *   - No direct Playwright import — only ctx.page.
 */

import type {
  PartSearchAdapter,
  ExecutionContext,
  PartQuery,
  PartResult,
  HealthStatus,
  AvailabilityStatus,
} from '../../shared/interfaces/adapter.types.js';

/** Adapters can't value-import from shared (it isn't mounted in the worker
 *  container — only adapters/ is). Signal "session expired" via a plain Error
 *  with a distinctive name; the runtime detects it by `err.name` rather than
 *  instanceof, so zero runtime deps on the shared directory are required. */
function authRequired(message: string): Error {
  const err = new Error(message);
  err.name = 'AuthRequiredError';
  return err;
}

const BASE_URL = 'https://speeddial.worldpac.com';
const LOGIN_URL = `${BASE_URL}/#/login`;
const HOME_URL = `${BASE_URL}/#/`;

interface PlaywrightPageLike {
  goto(
    url: string,
    opts?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      timeout?: number;
    },
  ): Promise<unknown>;
  waitForSelector(
    selector: string,
    opts?: { timeout?: number; state?: 'attached' | 'visible' | 'hidden' | 'detached' },
  ): Promise<unknown>;
  waitForFunction<R, A>(
    fn: (arg: A) => R,
    arg: A,
    opts?: { timeout?: number; polling?: number | 'raf' },
  ): Promise<unknown>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  evaluate<R>(fn: () => R): Promise<R>;
  url(): string;
  content(): Promise<string>;
}

function pageOf(ctx: ExecutionContext): PlaywrightPageLike {
  if (!ctx.page) {
    throw new Error('worldpac-speeddial: ExecutionContext.page missing — worker must run in browser mode');
  }
  return ctx.page as PlaywrightPageLike;
}

/** Poll `.product-quote` count until it stays constant for ~800ms or 10s
 *  elapses, then snapshot count + first row text. This gives the SPA time
 *  to finish rehydrating the previous /#/pna view from localStorage before
 *  we take the "before" signature — otherwise our pre-search baseline could
 *  be empty while the DOM is about to grow with stale rows, and the change
 *  detection downstream would trip on the rehydration instead of the real
 *  new-search response. */
async function waitForStableQuotes(
  page: PlaywrightPageLike,
): Promise<{ count: number; firstText: string }> {
  const MAX_MS = 10_000;
  const STABLE_MS = 800;
  const POLL_MS = 200;
  const started = Date.now();
  let lastCount = -1;
  let stableSince = 0;
  let snap: { count: number; firstText: string } = { count: 0, firstText: '' };
  while (Date.now() - started < MAX_MS) {
    snap = await page.evaluate(() => {
      const quotes = document.querySelectorAll('.product-quote');
      const first = quotes[0] as HTMLElement | null;
      return {
        count: quotes.length,
        firstText: first ? (first.innerText || '').trim().slice(0, 200) : '',
      };
    });
    if (snap.count === lastCount) {
      if (stableSince === 0) stableSince = Date.now();
      else if (Date.now() - stableSince >= STABLE_MS) break;
    } else {
      lastCount = snap.count;
      stableSince = 0;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return snap;
}

// ─── Page-side helpers (serialized & run inside the browser) ─────────────
// Kept as string-building fns so Playwright's page.evaluate receives plain functions.

function setReactValue(el: HTMLInputElement, val: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = desc?.set;
  if (setter) setter.call(el, val);
  else el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

interface ScrapedQuote {
  brand: string | null;
  /** Brand code parsed from the brand-logo URL (e.g. "OSR" for Sylvania,
   *  "PROT9" for ProTune). Used together with partNumber to build
   *  speedDIAL's internal productCode (`<partNumber padded to 18>><brandCode>`)
   *  that /v3/productdetails accepts. */
  brandCode: string | null;
  name: string | null;
  partNumber: string | null;
  priceText: string | null;
  availabilityLabel: string | null;
  availabilityClass: string | null;
  availabilityTitle: string | null;
  qtyText: string | null;
  warehouse: string | null;
  deliveryText: string | null;
  imageUrl: string | null;
}

/** Pad a part number to speedDIAL's 18-char fixed-width field with trailing
 *  spaces, then concatenate the brand code. Mirrors the `productCode` param
 *  observed on /v3/productdetails?productCode=H11.BX<14 spaces>OSR. */
function buildProductCode(partNumber: string, brandCode: string): string {
  const PAD = 18;
  const padded = partNumber.length >= PAD
    ? partNumber.slice(0, PAD)
    : partNumber + ' '.repeat(PAD - partNumber.length);
  return padded + brandCode;
}

// ─── Parsing helpers (run in Node) ───────────────────────────────────────

function parsePriceUSD(text: string | null | undefined): number {
  if (!text) return 0;
  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function parseQty(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const match = text.match(/(\d+)/);
  return match && match[1] !== undefined ? Number(match[1]) : undefined;
}

function mapAvailability(
  label: string | null,
  cls: string | null,
  qty: number | undefined,
): AvailabilityStatus {
  const l = (label ?? '').toLowerCase();
  const c = (cls ?? '').toLowerCase();
  if (c.includes('unavailable') || l.includes('not available') || l.includes('out of stock')) {
    return 'out_of_stock';
  }
  if (l.includes('in stock') || c.includes('available')) return 'in_stock';
  if (l.includes('on order') || l.includes('back order') || l.includes('special order')) {
    return 'on_order';
  }
  if (qty !== undefined) return qty > 0 ? 'in_stock' : 'out_of_stock';
  return 'unknown';
}

function parseDeliveryDays(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (/\btoday\b/.test(t)) return 0;
  if (/\btomorrow\b/.test(t)) return 1;
  const d = t.match(/(\d+)\s*day/);
  return d && d[1] !== undefined ? Number(d[1]) : undefined;
}

// ─── Adapter ─────────────────────────────────────────────────────────────

const adapter: PartSearchAdapter = {
  adapterId: 'worldpac-speeddial',
  adapterName: 'Worldpac speedDIAL 2.0',

  capabilities: {
    mode: 'browser',
    needsAuth: true,
    supportsBulkSearch: false,
    maxRPS: 1,
    searchByVIN: false,
    searchByCross: false,
    supportsPersistentSession: true,
  },

  async initialize(ctx: ExecutionContext): Promise<void> {
    ctx.logger.info('worldpac-speeddial: initialize');
  },

  async authenticate(ctx: ExecutionContext): Promise<void> {
    const creds = ctx.credentials;
    if (!creds || !creds.login || !creds.password) {
      throw new Error('worldpac-speeddial: missing ctx.credentials.{login,password}');
    }
    const page = pageOf(ctx);

    ctx.logger.info('worldpac-speeddial: navigating to login');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForSelector('#username', { timeout: 30_000, state: 'visible' });
    await page.waitForSelector('#password', { timeout: 5_000, state: 'visible' });

    await page.evaluate(
      ({ login, password, setterSrc }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const setReactValueFn = new Function('el', 'val', setterSrc) as (
          el: HTMLInputElement,
          v: string,
        ) => void;
        const u = document.querySelector<HTMLInputElement>('#username');
        const p = document.querySelector<HTMLInputElement>('#password');
        if (!u || !p) throw new Error('login inputs not found');
        setReactValueFn(u, login);
        setReactValueFn(p, password);
        const btn = document.querySelector<HTMLButtonElement>(
          'form[data-testid="login-form"] button[type="submit"]',
        );
        if (!btn) throw new Error('login submit button not found');
        btn.click();
      },
      {
        login: creds.login,
        password: creds.password,
        // Serialize the helper body for in-page execution without extra toolchain.
        setterSrc: `
          var proto = Object.getPrototypeOf(el);
          var desc = Object.getOwnPropertyDescriptor(proto, 'value');
          var setter = desc && desc.set;
          if (setter) { setter.call(el, val); } else { el.value = val; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        `,
      },
    );

    // Wait until we leave the login route OR a login error appears.
    await page.waitForFunction(
      () => {
        if (!location.hash.startsWith('#/login')) return true;
        const body = document.body.innerText || '';
        if (/failed to sign in/i.test(body)) return true;
        return false;
      },
      null,
      { timeout: 45_000, polling: 500 },
    );

    const loggedIn = await page.evaluate(() => !location.hash.startsWith('#/login'));
    if (!loggedIn) {
      throw new Error('worldpac-speeddial: login failed — check credentials');
    }

    // Ensure the home shell (with the global search bar) is mounted.
    await page.waitForSelector('#searchTerm', { timeout: 30_000, state: 'visible' }).catch(() => {
      /* some routes lack it; search() will re-check */
    });
    ctx.logger.info('worldpac-speeddial: authenticated');
  },

  async search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]> {
    const q = query.partNumber?.trim();
    if (!q) {
      ctx.logger.warn('worldpac-speeddial: empty partNumber');
      return [];
    }
    const page = pageOf(ctx);

    // Ensure the SPA shell is mounted. The search bar lives in the top
    // header and persists across routes. On a fresh page we must navigate
    // to the app origin first — goto(HOME_URL) renders the authenticated
    // shell (cookies carry the session); it does NOT clear cached /#/pna
    // rows from a prior search, which the SPA rehydrates from localStorage
    // on every page load.
    const hasBar = await page
      .evaluate(() => !!document.querySelector('#searchTerm'))
      .catch(() => false);
    if (!hasBar) {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForSelector('#searchTerm', { timeout: 30_000, state: 'visible' });
    }

    // Now that #searchTerm is in the DOM, check the auth state. Login check
    // happens after goto so a fresh page sees the real post-redirect state
    // (the redirect can happen after the initial hash is set).
    const onLogin = await page.evaluate(() => location.hash.startsWith('#/login')).catch(() => true);
    if (onLogin) {
      throw authRequired('worldpac-speeddial: session expired (landed on /#/login)');
    }

    // Capture the signature of the currently-rendered results AFTER the SPA
    // has had time to rehydrate. speedDIAL rehydrates the previous /#/pna
    // view from localStorage — on a persistent-session BrowserContext the
    // cache survives across jobs, so the DOM already contains stale
    // .product-quote rows before our new query has fired. We can't prevent
    // the rehydration (clearing localStorage kills the auth state), so we
    // wait for the quote count to stabilise, then snapshot both the count
    // and the first row's text. After the new search lands the SPA replaces
    // those rows with fresh data — either the count changes or the first
    // row's text differs, and both are the signals we'll wait on below.
    const stale = await waitForStableQuotes(page);
    ctx.logger.info('worldpac-speeddial: pre-search snapshot', {
      query: q,
      staleCount: stale.count,
      staleFirst: stale.firstText.slice(0, 60),
      url: page.url(),
    });

    await page.evaluate(
      ({ term, setterSrc }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const setReactValueFn = new Function('el', 'val', setterSrc) as (
          el: HTMLInputElement,
          v: string,
        ) => void;
        const input = document.querySelector<HTMLInputElement>('#searchTerm');
        if (!input) throw new Error('#searchTerm missing');
        setReactValueFn(input, term);
        input.focus();
        const evt = (type: string) =>
          new KeyboardEvent(type, {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
          });
        input.dispatchEvent(evt('keydown'));
        input.dispatchEvent(evt('keypress'));
        input.dispatchEvent(evt('keyup'));
      },
      {
        term: q,
        setterSrc: `
          var proto = Object.getPrototypeOf(el);
          var desc = Object.getOwnPropertyDescriptor(proto, 'value');
          var setter = desc && desc.set;
          if (setter) { setter.call(el, val); } else { el.value = val; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        `,
      },
    );

    // Wait until either:
    //   (a) the count of .product-quote rows changes from the pre-search
    //       snapshot (new search returned a different number of results), OR
    //   (b) the first row's text differs (same count, different products), OR
    //   (c) an explicit empty-state "no products" message appears.
    // Checking only "some .product-quote exists" is wrong for worldpac —
    // the SPA rehydrates the previous query's rows before our pna360 fetch
    // completes, so that signal would unblock on stale cached DOM.
    try {
      await page.waitForFunction(
        (prev: { count: number; firstText: string }) => {
          if (!location.hash.startsWith('#/pna')) return false;
          const body = (document.body.innerText || '').toLowerCase();
          if (/no (matching )?products?|no results|not found/.test(body)
              && document.querySelectorAll('.product-quote').length === 0) {
            return true;
          }
          const quotes = document.querySelectorAll('.product-quote');
          if (quotes.length === 0) return false;
          if (quotes.length !== prev.count) return true;
          const first = quotes[0] as HTMLElement | null;
          if (!first) return false;
          const sig = (first.innerText || '').trim().slice(0, 200);
          return sig.length > 0 && sig !== prev.firstText;
        },
        stale,
        { timeout: 45_000, polling: 300 },
      );
    } catch (err) {
      const nowSnap = await page
        .evaluate(() => {
          const quotes = document.querySelectorAll('.product-quote');
          const first = quotes[0] as HTMLElement | null;
          return {
            hash: location.hash,
            count: quotes.length,
            firstText: first ? (first.innerText || '').trim().slice(0, 120) : '',
            bodySample: (document.body.innerText || '').slice(0, 200),
          };
        })
        .catch(() => null);
      ctx.logger.warn('worldpac-speeddial: wait-for-change timed out', {
        query: q,
        staleCount: stale.count,
        staleFirst: stale.firstText.slice(0, 60),
        ...(nowSnap ? { current: nowSnap } : {}),
      });
      throw err;
    }

    // Give React a beat to finish reconciling the full result set so every
    // row has its price, availability, and image src populated.
    await new Promise((r) => setTimeout(r, 400));

    // Trigger lazy-load so .sd-part-image src populates with the real URL
    // instead of the placeholder SVG. speedDIAL uses IntersectionObserver —
    // scrolling each row into view is enough to kick off the fetch. Then
    // wait briefly for all real URLs to resolve (or give up after 3s, in
    // which case we fall back to the brand logo).
    await page.evaluate(() => {
      document.querySelectorAll('.product-quote img.sd-part-image').forEach((el) => {
        (el as HTMLElement).scrollIntoView({ block: 'center' });
      });
    });
    try {
      await page.waitForFunction(
        () => {
          const imgs = Array.from(
            document.querySelectorAll('.product-quote img.sd-part-image'),
          ) as HTMLImageElement[];
          if (imgs.length === 0) return true;
          return imgs.every((el) => {
            const s = el.currentSrc || el.src || '';
            return s.length > 0 && !s.startsWith('data:');
          });
        },
        null,
        { timeout: 3_000, polling: 200 },
      );
    } catch {
      // Non-fatal: rows without a resolved product photo fall back to the
      // brand logo in the scrape below.
    }

    const scraped: ScrapedQuote[] = await page.evaluate(() => {
      const text = (el: Element | null | undefined): string | null =>
        el ? (el as HTMLElement).innerText.trim() : null;

      const getRow = (root: Element, label: string): string | null => {
        const rows = root.querySelectorAll('.name-value-row');
        for (const r of Array.from(rows)) {
          const name = (r.querySelector('.name-column') as HTMLElement | null)?.innerText
            ?.trim()
            ?.toLowerCase();
          if (name && name.startsWith(label.toLowerCase())) {
            return (r.querySelector('.value-column') as HTMLElement | null)?.innerText?.trim() ?? null;
          }
        }
        return null;
      };

      const quotes = Array.from(document.querySelectorAll('.product-quote'));
      return quotes.map((q) => {
        const brandImg = q.querySelector('img.sd-brand-image') as HTMLImageElement | null;
        const brand = brandImg?.alt || brandImg?.title || null;
        // brandCode from logo URL: /brands/OSR.gif → "OSR", /brands/PROT9.gif → "PROT9"
        const brandSrc = brandImg?.currentSrc || brandImg?.src || '';
        const brandCodeMatch = brandSrc.match(/\/brands\/([^./]+)\.[a-z]+$/i);
        const brandCode = brandCodeMatch?.[1] ?? null;
        // Prefer the real product photo (sd-part-image) over the brand logo
        // (sd-brand-image). Some rows only have the brand logo — fall back
        // then. `.src` from the DOM API is always absolute; currentSrc
        // resolves srcset picks.
        const partImg = q.querySelector('img.sd-part-image') as HTMLImageElement | null;
        const pickSrc = (el: HTMLImageElement | null): string | null => {
          if (!el) return null;
          const raw = el.currentSrc || el.src || el.getAttribute('src') || '';
          const t = raw.trim();
          // Ignore inline SVG placeholders (lazy-load spinners and
          // IMAGE NOT AVAILABLE fallbacks) — they're not real product
          // photos and the caller prefers the brand logo in that case.
          if (t.length === 0 || t.startsWith('data:')) return null;
          return t;
        };
        const imageUrl = pickSrc(partImg) ?? pickSrc(brandImg);
        const links = Array.from(q.querySelectorAll('.product-detail-link')) as HTMLElement[];
        const name = text(q.querySelector('.product-description .bold-text')) ?? text(links[0]);
        const productId = q.querySelector('.product-detail-link.product-id') as HTMLElement | null;
        const partNumber = productId?.innerText?.trim() ?? (links[1]?.innerText?.trim() || null);

        const priceText = getRow(q, 'Price');
        const availValue = getRow(q, 'Avail');
        const submitBy = getRow(q, 'Submit');

        const availEl = q.querySelector('.item-availability') as HTMLElement | null;
        const availabilityLabel = availEl?.innerText?.trim() ?? null;
        const availabilityClass = availEl?.className ?? null;
        const icon = q.querySelector('.sd-availability-icon') as HTMLElement | null;
        const availabilityTitle = icon?.getAttribute('title') ?? null;

        // availValue example: "Qty:16\n \nNY Jamaica"
        let qtyText: string | null = null;
        let warehouse: string | null = null;
        if (availValue) {
          const lines = availValue
            .split(/\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          for (const line of lines) {
            const m = line.match(/Qty\s*:?\s*(\d+)/i);
            if (m) {
              qtyText = m[1] ?? null;
              continue;
            }
            if (!warehouse && !/^qty/i.test(line)) warehouse = line;
          }
        }

        return {
          brand,
          brandCode,
          name,
          partNumber,
          priceText,
          availabilityLabel,
          availabilityClass,
          availabilityTitle,
          qtyText,
          warehouse,
          deliveryText: submitBy,
          imageUrl,
        } as ScrapedQuote;
      });
    });

    const now = new Date();
    // The product-detail route (#/product-detail) is driven by React state,
    // not URL params — there's no shareable per-product link in the UI. We
    // fall back to the list URL for human navigation, and expose the internal
    // API URL in `raw.productDetailsApi` for machine consumers that can reuse
    // the authenticated session.
    const listUrl = page.url();

    const results: PartResult[] = [];
    for (const r of scraped) {
      if (!r.partNumber) continue;
      const price = parsePriceUSD(r.priceText);
      const qty = parseQty(r.qtyText);
      const availability = mapAvailability(r.availabilityLabel, r.availabilityClass, qty);
      const deliveryDays = parseDeliveryDays(r.deliveryText);

      const productCode = r.brandCode ? buildProductCode(r.partNumber, r.brandCode) : null;
      const productDetailsApi = productCode
        ? `${BASE_URL}/v3/productdetails?productCode=${encodeURIComponent(productCode)}`
        : null;

      const raw: Record<string, unknown> = {};
      if (r.brandCode) raw['brandCode'] = r.brandCode;
      if (productCode) raw['productCode'] = productCode;
      if (productDetailsApi) raw['productDetailsApi'] = productDetailsApi;
      if (r.availabilityTitle) raw['availabilityTitle'] = r.availabilityTitle;

      const out: PartResult = {
        partNumber: r.partNumber,
        brand: r.brand ?? 'unknown',
        name: r.name ?? r.partNumber,
        price,
        currency: 'USD',
        availability,
        source: ctx.siteId,
        sourceUrl: listUrl,
        updatedAt: now,
      };
      if (qty !== undefined) out.quantity = qty;
      if (r.warehouse) out.warehouse = r.warehouse;
      if (deliveryDays !== undefined) out.deliveryDays = deliveryDays;
      if (r.imageUrl) out.imageUrl = r.imageUrl;
      if (Object.keys(raw).length > 0) out.raw = raw;
      results.push(out);
    }

    ctx.logger.info('worldpac-speeddial: search done', {
      query: q,
      scraped: scraped.length,
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
        return { ok: false, latencyMs: Date.now() - t0, error: `HTTP ${res.status}`, checkedAt };
      }
      const body = await res.text();
      // The SPA shell always returns the same HTML; sanity-check the title.
      const titleOk = /speedDIAL\s*2\.0/i.test(body);
      if (!titleOk) {
        return {
          ok: false,
          latencyMs: Date.now() - t0,
          error: 'unexpected HTML shell',
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

// Expose page-side helper type for tooling; not used at runtime.
export type { ScrapedQuote };

// Dead-code suppression for the Node-side helper (imported by tests if needed).
void setReactValue;

export default adapter;

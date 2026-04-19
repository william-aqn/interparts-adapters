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
  name: string | null;
  partNumber: string | null;
  priceText: string | null;
  availabilityLabel: string | null;
  availabilityClass: string | null;
  availabilityTitle: string | null;
  qtyText: string | null;
  warehouse: string | null;
  deliveryText: string | null;
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
  siteId: 'worldpac-speeddial',
  siteName: 'Worldpac speedDIAL 2.0',

  capabilities: {
    mode: 'browser',
    needsAuth: true,
    supportsBulkSearch: false,
    maxRPS: 1,
    searchByVIN: false,
    searchByCross: false,
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

    // If we somehow landed back on login (session expired), re-authenticate.
    const onLogin = await page.evaluate(() => location.hash.startsWith('#/login')).catch(() => true);
    if (onLogin) {
      if (!adapter.authenticate) throw new Error('authenticate not defined');
      await adapter.authenticate(ctx);
    }

    // Ensure the search bar is mounted (home shell or any authenticated route).
    const hasBar = await page
      .evaluate(() => !!document.querySelector('#searchTerm'))
      .catch(() => false);
    if (!hasBar) {
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForSelector('#searchTerm', { timeout: 30_000, state: 'visible' });
    }

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

    // Wait for the PnA route to render results OR an empty-state.
    await page.waitForFunction(
      () => {
        if (!location.hash.startsWith('#/pna')) return false;
        if (document.querySelector('.product-quote')) return true;
        const body = (document.body.innerText || '').toLowerCase();
        if (/no (matching )?products?|no results|not found/.test(body)) return true;
        return false;
      },
      null,
      { timeout: 45_000, polling: 500 },
    );

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
        const img = q.querySelector('img.sd-brand-image') as HTMLImageElement | null;
        const brand = img?.alt || img?.title || null;
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
          name,
          partNumber,
          priceText,
          availabilityLabel,
          availabilityClass,
          availabilityTitle,
          qtyText,
          warehouse,
          deliveryText: submitBy,
        } as ScrapedQuote;
      });
    });

    const now = new Date();
    const sourceUrl = page.url();

    const results: PartResult[] = [];
    for (const r of scraped) {
      if (!r.partNumber) continue;
      const price = parsePriceUSD(r.priceText);
      const qty = parseQty(r.qtyText);
      const availability = mapAvailability(r.availabilityLabel, r.availabilityClass, qty);
      const deliveryDays = parseDeliveryDays(r.deliveryText);

      const out: PartResult = {
        partNumber: r.partNumber,
        brand: r.brand ?? 'unknown',
        name: r.name ?? r.partNumber,
        price,
        currency: 'USD',
        availability,
        source: 'worldpac-speeddial',
        sourceUrl,
        updatedAt: now,
      };
      if (qty !== undefined) out.quantity = qty;
      if (r.warehouse) out.warehouse = r.warehouse;
      if (deliveryDays !== undefined) out.deliveryDays = deliveryDays;
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

/**
 * e2e-runner.ts — shared helper for adapter E2E tests.
 *
 * Phase 1: minimal mock ExecutionContext (real fetch, null-object cookies/logger).
 * Phase 2+ will extend with:
 *   - Real CookieJar (tough-cookie)
 *   - Proxy-aware fetch wrapper
 *   - Playwright context for browser adapters
 *   - Validation: PartResult shape, required fields, timing budget
 */

import type {
  ExecutionContext,
  PartSearchAdapter,
  PartQuery,
  PartResult,
  CookieJar,
  Logger,
} from '../interfaces/adapter.types.js';

class NullCookieJar implements CookieJar {
  async getCookieString(_url: string): Promise<string> { return ''; }
  async setCookie(_cookie: string, _url: string): Promise<void> { /* noop */ }
}

const testLogger: Logger = {
  info: (msg, ...args) => console.log(`[adapter:info] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[adapter:warn] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[adapter:error] ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[adapter:debug] ${msg}`, ...args),
};

export function createTestContext(overrides?: Partial<ExecutionContext> & { siteId?: string }): ExecutionContext {
  const base: ExecutionContext = {
    fetch: globalThis.fetch,
    cookies: new NullCookieJar(),
    logger: testLogger,
    siteId: overrides?.siteId ?? 'test-site',
  };
  return { ...base, ...overrides };
}

export interface AdapterTestOptions {
  /** Timeout per call in ms. Default: 15000. */
  timeoutMs?: number;
  /** Extra validations to run against each PartResult. */
  validate?: (result: PartResult) => void;
}

export async function runAdapterSearch(
  adapter: PartSearchAdapter,
  query: PartQuery,
  opts: AdapterTestOptions = {},
): Promise<PartResult[]> {
  const ctx = createTestContext({ siteId: adapter.adapterId });
  await adapter.initialize(ctx);
  if (adapter.capabilities.needsAuth && adapter.authenticate) {
    await adapter.authenticate(ctx);
  }
  const results = await adapter.search(ctx, query);

  if (opts.validate) {
    for (const r of results) opts.validate(r);
  }
  return results;
}

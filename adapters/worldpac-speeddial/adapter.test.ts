/**
 * worldpac-speeddial adapter tests.
 *
 * Like demo-browser, the full flow needs a live Playwright context, which
 * lives in the worker containers. Locally we validate:
 *   - metadata matches meta.json
 *   - search() throws without ctx.page (browser-mode invariant)
 *   - authenticate() throws without credentials
 *   - healthCheck() hits the SPA shell via ctx.fetch
 */

import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';
import meta from './meta.json' with { type: 'json' };
import { createTestContext } from '../../shared/test-helpers/e2e-runner.js';

const skipOnline = process.env['SKIP_ONLINE'] === '1';

describe('worldpac-speeddial adapter', () => {
  it('declares matching metadata', () => {
    expect(adapter.adapterId).toBe('worldpac-speeddial');
    expect(adapter.adapterId).toBe(meta.adapterId);
    expect(adapter.capabilities.mode).toBe('browser');
    expect(adapter.capabilities.needsAuth).toBe(true);
    expect(adapter.authenticate).toBeTypeOf('function');
  });

  it('opts into persistent-session mode', () => {
    expect(adapter.capabilities.supportsPersistentSession).toBe(true);
  });

  it('search() signals AuthRequiredError when the SPA lands on /#/login', async () => {
    // Fake page stub — enough for search() to reach the onLogin branch before
    // needing a real #searchTerm. `evaluate` returns true for the login-hash
    // probe, after which search() should throw AuthRequiredError.
    const ctx = createTestContext();
    const fakePage = {
      async evaluate<R>(fn: () => R): Promise<R> {
        const src = fn.toString();
        if (src.includes("location.hash.startsWith('#/login')")) {
          return true as unknown as R;
        }
        throw new Error('unexpected page.evaluate call: ' + src);
      },
    };
    const ctxWithPage = { ...ctx, page: fakePage } as unknown as Parameters<typeof adapter.search>[0];
    await expect(adapter.search(ctxWithPage, { partNumber: 'BLBH11' })).rejects.toMatchObject({
      name: 'AuthRequiredError',
    });
  });

  it('search() throws when ExecutionContext.page is missing', async () => {
    const ctx = createTestContext();
    await adapter.initialize(ctx);
    await expect(adapter.search(ctx, { partNumber: 'BLBH11' })).rejects.toThrow(/page missing/);
  });

  it('authenticate() rejects when credentials are missing', async () => {
    const ctx = createTestContext(); // no credentials
    await adapter.initialize(ctx);
    await expect(adapter.authenticate!(ctx)).rejects.toThrow(/credentials/i);
  });

  it.skipIf(skipOnline)('healthCheck passes against the SPA shell', async () => {
    const ctx = createTestContext();
    const h = await adapter.healthCheck(ctx);
    expect(typeof h.ok).toBe('boolean');
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h.checkedAt).toBeInstanceOf(Date);
  }, 15_000);
});

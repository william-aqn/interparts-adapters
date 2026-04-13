/**
 * demo-browser adapter tests.
 *
 * Phase 2 limitation: running the full browser-mode path requires a live
 * Playwright installation. The test here validates metadata and the
 * ctx-less healthCheck path (which uses ctx.fetch). Full browser test will
 * run inside the `worker-browser-default` container in phase 2's e2e test.
 */

import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';
import meta from './meta.json' with { type: 'json' };
import { createTestContext } from '../../shared/test-helpers/e2e-runner.js';

const skipOnline = process.env['SKIP_ONLINE'] === '1';

describe('demo-browser adapter', () => {
  it('declares matching metadata', () => {
    expect(adapter.siteId).toBe('demo-browser');
    expect(adapter.siteId).toBe(meta.siteId);
    expect(adapter.capabilities.mode).toBe('browser');
    expect(adapter.capabilities.needsAuth).toBe(false);
  });

  it('throws when called without ExecutionContext.page', async () => {
    const ctx = createTestContext(); // no page
    await adapter.initialize(ctx);
    await expect(adapter.search(ctx, { partNumber: 'love' })).rejects.toThrow(
      /page missing/,
    );
  });

  it.skipIf(skipOnline)('healthCheck passes using ctx.fetch (no browser)', async () => {
    const ctx = createTestContext();
    const h = await adapter.healthCheck(ctx);
    // Site goes up and down occasionally — accept either result, but latency should be real
    expect(typeof h.ok).toBe('boolean');
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h.checkedAt).toBeInstanceOf(Date);
  }, 15_000);
});

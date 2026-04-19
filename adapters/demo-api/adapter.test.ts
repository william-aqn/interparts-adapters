/**
 * demo-api adapter tests (real HTTP to httpbin.org).
 */

import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';
import meta from './meta.json' with { type: 'json' };
import { runAdapterSearch, createTestContext } from '../../shared/test-helpers/e2e-runner.js';
import type { PartResult } from '../../shared/interfaces/adapter.types.js';

const skipOnline = process.env['SKIP_ONLINE'] === '1';

describe('demo-api adapter', () => {
  it('declares matching metadata', () => {
    expect(adapter.adapterId).toBe('demo-api');
    expect(adapter.adapterId).toBe(meta.adapterId);
    expect(adapter.capabilities.mode).toBe('api');
    expect(adapter.capabilities.needsAuth).toBe(false);
  });

  it.skipIf(skipOnline)('returns synthetic PartResult[]', async () => {
    const results = await runAdapterSearch(
      adapter,
      { partNumber: meta.healthCheckQuery, limit: 5 },
      {
        validate: (r: PartResult) => {
          expect(r.source).toBe(adapter.adapterId);
          expect(r.currency).toBe('USD');
          expect(r.availability).toBe('in_stock');
          expect(typeof r.price).toBe('number');
          expect(r.partNumber.length).toBeGreaterThan(0);
        },
      },
    );
    expect(results.length).toBeGreaterThan(0);
  }, 20_000);

  it.skipIf(skipOnline)('healthCheck passes on live upstream', async () => {
    const ctx = createTestContext();
    const h = await adapter.healthCheck(ctx);
    expect(h.ok).toBe(true);
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
  }, 15_000);
});

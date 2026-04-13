/**
 * demo-http adapter — integration test (real HTTP to dummyjson.com).
 *
 * This test is deliberately online: dummyjson.com is a public, stable test API.
 * Skipping online tests in CI would defeat phase-1's goal of proving the end-to-end
 * pipeline works. If CI has no internet, set SKIP_ONLINE=1 to skip.
 */

import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';
import meta from './meta.json' with { type: 'json' };
import { createTestContext, runAdapterSearch } from '../../shared/test-helpers/e2e-runner.js';
import type { PartResult } from '../../shared/interfaces/adapter.types.js';

const skipOnline = process.env['SKIP_ONLINE'] === '1';

describe('demo-http adapter', () => {
  it('declares matching metadata', () => {
    expect(adapter.siteId).toBe('demo-http');
    expect(adapter.siteId).toBe(meta.siteId);
    expect(adapter.siteName).toBe(meta.siteName);
    expect(adapter.capabilities.mode).toBe('http');
    expect(adapter.capabilities.needsAuth).toBe(false);
  });

  it.skipIf(skipOnline)('returns PartResult[] for a simple query', async () => {
    const results = await runAdapterSearch(
      adapter,
      { partNumber: meta.healthCheckQuery, limit: 5 },
      {
        validate: (r: PartResult) => {
          expect(r.source).toBe('demo-http');
          expect(typeof r.partNumber).toBe('string');
          expect(r.partNumber.length).toBeGreaterThan(0);
          expect(typeof r.name).toBe('string');
          expect(r.name.length).toBeGreaterThan(0);
          expect(Number.isFinite(r.price)).toBe(true);
          expect(r.currency).toBe('USD');
          expect(['in_stock', 'on_order', 'out_of_stock', 'unknown']).toContain(r.availability);
          expect(r.updatedAt).toBeInstanceOf(Date);
        },
      },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
  }, 20_000);

  it.skipIf(skipOnline)('returns [] for obviously empty query', async () => {
    const ctx = createTestContext();
    await adapter.initialize(ctx);
    const results = await adapter.search(ctx, { partNumber: '', limit: 5 });
    expect(results).toEqual([]);
  });

  it.skipIf(skipOnline)('healthCheck reports ok for a live upstream', async () => {
    const ctx = createTestContext();
    const h = await adapter.healthCheck(ctx);
    expect(h.ok).toBe(true);
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h.checkedAt).toBeInstanceOf(Date);
  }, 15_000);
});

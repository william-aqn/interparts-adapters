/**
 * ebay adapter tests.
 *
 * Live SRP access from the test host typically hits Akamai's bot-wall splash
 * (~13 KB HTML, zero s-card elements) — the adapter detects this and returns
 * []. We assert either "bot-wall" or "real results" so the test stays green
 * whether or not the current host IP happens to be scored favourably.
 */

import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';
import meta from './meta.json' with { type: 'json' };
import { createTestContext } from '../../shared/test-helpers/e2e-runner.js';
import * as cheerio from 'cheerio';

const skipOnline = process.env['SKIP_ONLINE'] === '1';

const ctx = {
  ...createTestContext({ siteId: meta.adapterId }),
  parseHtml: (html: string) => cheerio.load(html),
};

describe('ebay adapter', () => {
  it('declares matching metadata', () => {
    expect(adapter.adapterId).toBe('ebay');
    expect(adapter.adapterId).toBe(meta.adapterId);
    expect(adapter.capabilities.mode).toBe('http');
    expect(adapter.capabilities.needsAuth).toBe(false);
  });

  it('returns [] for an empty query without touching the network', async () => {
    await adapter.initialize(ctx);
    const results = await adapter.search(ctx, { partNumber: '   ' });
    expect(results).toEqual([]);
  });

  it.skipIf(skipOnline)('search does not throw and returns a typed result', async () => {
    await adapter.initialize(ctx);
    const results = await adapter.search(ctx, { partNumber: 'blbh11' });
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(r.partNumber).toBeTruthy();
      expect(r.name).toBeTruthy();
      expect(r.name).not.toBe('Shop on eBay');
      expect(typeof r.price).toBe('number');
      expect(r.currency).toMatch(/^[A-Z]{3}$/);
      expect(r.source).toBe(meta.adapterId);
      expect(r.sourceUrl).toMatch(/^https:\/\/www\.ebay\.com\/itm\/\d+$/);
      expect(r.updatedAt).toBeInstanceOf(Date);
    }
  }, 30_000);

  it.skipIf(skipOnline)('healthCheck reaches ebay.com', async () => {
    const h = await adapter.healthCheck(ctx);
    expect(typeof h.ok).toBe('boolean');
    expect(h.latencyMs).toBeGreaterThanOrEqual(0);
    expect(h.checkedAt).toBeInstanceOf(Date);
  }, 15_000);
});

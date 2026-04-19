import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';
import { createTestContext } from '../../shared/test-helpers/e2e-runner.js';
import meta from './meta.json' with { type: 'json' };
import * as cheerio from 'cheerio';

const ctx = {
  ...createTestContext({ siteId: meta.adapterId }),
  parseHtml: (html: string) => cheerio.load(html),
};

describe(meta.adapterId, () => {
  it('has the declared capabilities', () => {
    expect(adapter.adapterId).toBe('rockauto');
    expect(adapter.capabilities.mode).toBe('http');
    expect(adapter.capabilities.needsAuth).toBe(false);
  });

  it('returns [] for a nonsense part number', async () => {
    await adapter.initialize(ctx);
    const results = await adapter.search(ctx, {
      partNumber: 'ZZZZZNOTAREALPART9999',
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  }, 30_000);

  it('parses a real search (partnum=PF48E)', async () => {
    await adapter.initialize(ctx);
    const results = await adapter.search(ctx, { partNumber: 'PF48E' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.partNumber).toBeTruthy();
      expect(r.brand).toBeTruthy();
      expect(r.name).toBeTruthy();
      expect(typeof r.price).toBe('number');
      expect(r.price).toBeGreaterThan(0);
      expect(r.currency).toMatch(/^[A-Z]{3}$/);
      expect(r.source).toBe(meta.adapterId);
      expect(r.updatedAt).toBeInstanceOf(Date);
    }
  }, 30_000);

  it('respects the limit option', async () => {
    await adapter.initialize(ctx);
    const results = await adapter.search(ctx, {
      partNumber: 'W163',
      limit: 3,
    });
    expect(results.length).toBeLessThanOrEqual(3);
  }, 30_000);

  it('healthCheck reports reachable site', async () => {
    const hs = await adapter.healthCheck(ctx);
    expect(hs.ok).toBe(true);
    expect(typeof hs.latencyMs).toBe('number');
  }, 30_000);
});

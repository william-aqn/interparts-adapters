/**
 * ebay-api adapter tests.
 *
 * Live tests run only when EBAY_APP_ID / EBAY_CERT_ID are set in the env
 * (developer.ebay.com → My Account → Keysets). Without them we only verify
 * metadata, the auth-required guard, and the empty-query path so the
 * no-credential CI pipeline still passes.
 */

import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';
import meta from './meta.json' with { type: 'json' };
import { createTestContext } from '../../shared/test-helpers/e2e-runner.js';

const appId = process.env['EBAY_APP_ID'];
const certId = process.env['EBAY_CERT_ID'];
const hasLiveCreds = !!(appId && certId);
const skipOnline = process.env['SKIP_ONLINE'] === '1';

function ctxWithCreds() {
  return {
    ...createTestContext({ siteId: meta.adapterId }),
    credentials: {
      login: appId ?? '',
      password: certId ?? '',
    },
  };
}

describe('ebay-api adapter', () => {
  it('declares matching metadata', () => {
    expect(adapter.adapterId).toBe('ebay-api');
    expect(adapter.adapterId).toBe(meta.adapterId);
    expect(adapter.capabilities.mode).toBe('api');
    expect(adapter.capabilities.needsAuth).toBe(true);
  });

  it('returns [] for an empty query without touching the network', async () => {
    const ctx = ctxWithCreds();
    await adapter.initialize(ctx);
    const results = await adapter.search(ctx, { partNumber: '   ' });
    expect(results).toEqual([]);
  });

  it('throws AuthRequiredError when credentials are missing', async () => {
    const ctx = createTestContext({ siteId: meta.adapterId });
    await adapter.initialize(ctx);
    await expect(adapter.search(ctx, { partNumber: 'blbh11' })).rejects.toThrow(
      /credentials missing|clientId/,
    );
  });

  it.skipIf(!hasLiveCreds || skipOnline)(
    'live search returns typed PartResult[]',
    async () => {
      const ctx = ctxWithCreds();
      await adapter.initialize(ctx);
      await adapter.authenticate!(ctx);
      const results = await adapter.search(ctx, { partNumber: 'blbh11', limit: 5 });
      expect(Array.isArray(results)).toBe(true);
      for (const r of results) {
        expect(r.partNumber).toBeTruthy();
        expect(r.name).toBeTruthy();
        expect(typeof r.price).toBe('number');
        expect(r.currency).toMatch(/^[A-Z]{3}$/);
        expect(r.source).toBe(meta.adapterId);
        expect(r.sourceUrl).toMatch(/^https?:\/\//);
        expect(r.updatedAt).toBeInstanceOf(Date);
      }
    },
    30_000,
  );

  it.skipIf(!hasLiveCreds || skipOnline)(
    'healthCheck is green with valid creds',
    async () => {
      const ctx = ctxWithCreds();
      const h = await adapter.healthCheck(ctx);
      expect(h.ok).toBe(true);
      expect(typeof h.latencyMs).toBe('number');
    },
    30_000,
  );
});

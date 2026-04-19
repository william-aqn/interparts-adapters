# CLAUDE.md — guidance for Claude sessions on `interparts-adapters`

> This file is a reference for Claude agents — both human-driven sessions and
> the automated AI Pipeline (ai-pipeline service in interparts-core) that
> generates and fixes adapters autonomously.

## Project

Per-supplier adapters for Inter Parts Aggregator — parallel auto parts search
across ~60 websites. Full spec: `../interparts-info/README.md` (section 4 for
adapter contract, section 9 for AI pipeline, section 19 for security rules).

Two sibling repositories (must share the same parent directory):
- **`interparts-adapters`** (this) — adapters, shared types, prompt templates
- **`interparts-core`** — infrastructure: microservices, Docker, CI/CD, tests

## Repository structure

```
interparts-adapters/
  adapters/
    <adapterId>/          # directory = the adapter's logical id
      adapter.ts          # PartSearchAdapter implementation
      adapter.test.ts     # E2E test (real HTTP, vitest)
      meta.json           # adapter config (url, mode, limits, prompt hints)
    demo-http/            # always-present demo adapter (dummyjson.com)
    demo-api/             # API-mode demo
    demo-browser/         # Browser-mode demo
  shared/
    interfaces/
      adapter.types.ts    # COPY of interparts-core/workers/src/interfaces/adapter.types.ts
    test-helpers/          # mock ExecutionContext for adapter tests
    utils/                 # shared parsing utilities
  templates/
    prompt-generate.md    # Mustache template for Claude "generate" prompt
    prompt-fix.md         # Mustache template for Claude "fix" prompt
  package.json            # @interparts/adapters, Node >=22, vitest, cheerio
  tsconfig.json           # strict, noUncheckedIndexedAccess, ES2022, NodeNext
```

**Adapter vs Site (core concept).** Adapters are first-class entities — reusable
code packages that talk to one supplier. Sites are per-installation records: they
each pick one adapter and supply their own credentials, proxy, and
`healthCheckQuery`. Many sites can share the same adapter (e.g. multiple
customer accounts on one supplier). The adapter's code uses `ctx.siteId` to
populate `PartResult.source`, not the adapter's own id.

## Tech stack

- **TypeScript 5.6**, `strict: true`, `noUncheckedIndexedAccess: true`
- **Node >= 22** (ESM, `"type": "module"`)
- **Cheerio 1.x** — HTML parsing for `http` mode adapters
- **Vitest 2.x** — E2E tests
- **Playwright** — available via `ctx.page` for `browser` mode adapters (injected by worker runtime)

## Adapter contract

Every adapter default-exports an object satisfying `PartSearchAdapter` from
`shared/interfaces/adapter.types.ts`:

```typescript
import type { PartSearchAdapter } from '../../shared/interfaces/adapter.types.js';

const adapter: PartSearchAdapter = {
  adapterId: 'example',
  adapterName: 'Example Parts Store',
  capabilities: {
    mode: 'http', needsAuth: false, supportsBulkSearch: false,
    maxRPS: 3, searchByVIN: false, searchByCross: false,
    // supportsPersistentSession?: true — opt into keep-alive auth (see below)
  },

  async initialize(ctx) { /* one-time setup: login, cookie fetch */ },
  async search(ctx, query) { /* returns PartResult[] */ },
  async healthCheck(ctx) { /* quick sanity probe */ },
};

export default adapter;
```

**Imports from `shared/` MUST be type-only.** The worker container mounts
only `adapters/` at `/app/adapters` — `shared/` is not available at runtime.
`import type { ... }` is erased by TS; `import { ClassName, ... }` would fail
at Node's dynamic-import step. This is why `AuthRequiredError` (below) is
signalled by `name`, not `instanceof`.

### Three modes

| Mode | When to use | Available via `ctx` |
|------|-------------|---------------------|
| `api` | Site has a JSON API | `ctx.fetch` |
| `http` | Simple HTML, no JS needed | `ctx.fetch`, `ctx.parseHtml` (Cheerio) |
| `browser` | SPA, AJAX, anti-bot | `ctx.page`, `ctx.browserContext` (Playwright) |

**Principle: always choose the lightest mode that works.** If `fetch(url)` returns usable HTML, don't use Playwright.

### PartResult required fields

```typescript
{
  partNumber: string;     // raw OEM/article number
  brand: string;
  name: string;
  price: number;          // parsed as number, NOT string
  currency: string;       // ISO 4217: RUB, USD, EUR, KZT
  availability: 'in_stock' | 'on_order' | 'out_of_stock' | 'unknown';
  source: string;         // MUST equal ctx.siteId (the calling site, not the adapter)
  updatedAt: Date;        // new Date()
}
```

Optional: `quantity`, `deliveryDays`, `deliveryCity`, `warehouse`, `sourceUrl`, `imageUrl`, `crossNumbers`.

**Never fabricate data** — if a field is unavailable on the page, leave it `undefined`.

### Persistent session (optional — opt in via capability)

For adapters where the login step is expensive (SPA auth, multi-step OAuth), the
runtime can hold the authenticated session across jobs. Participation is
explicit:

1. Set `capabilities.supportsPersistentSession: true`.
2. Ensure `initialize()` / `authenticate()` are **idempotent** (safe to call on
   fresh state even though the runtime only calls them once per session).
3. When `search()` detects that the server expired the session (redirect to
   login, 401/403, etc.) **throw a plain Error tagged with `name = 'AuthRequiredError'`.**
   The runtime disposes the cached session and retries the call once with a
   fresh auth. Do **not** inline-re-login from `search()` anymore — that made
   retry semantics unclear and is now the runtime's job.

```typescript
function authRequired(msg: string): Error {
  const e = new Error(msg); e.name = 'AuthRequiredError'; return e;
}

async search(ctx, q) {
  // ...detect login-wall...
  if (onLogin) throw authRequired('session expired');
  // normal flow
}
```

Whether a given Site actually uses persistent mode is decided per-installation
on the Site record (`persistentSession: boolean`) — see
`interparts-info/README.md §5.4-bis`. A site without the flag still works with
a persistent-capable adapter; it just pays full auth per job.

## Security rules (CRITICAL)

These are enforced by `CodeValidator` in the AI Pipeline before any code is committed.
Violations cause immediate rejection.

| Rule | Detail |
|------|--------|
| No unauthorized URLs | Only access URLs from `meta.json` (`url` field + `prompt.apiNotes`) |
| No `process.env` | Except `PLAYWRIGHT_SKIP` and `NODE_OPTIONS` |
| No `eval()` / `new Function()` | Never |
| No `child_process` / `fs.write*` / `net.*` / `dgram.*` | Never |
| No direct HTTP imports | No `http`, `https`, `node-fetch`, `axios`, `got` — all HTTP via `ctx.fetch` |
| No hardcoded credentials | All auth via `ctx.credentials` |
| No file writes | Read-only: parse HTML/JSON, return `PartResult[]` |

## meta.json schema

```json
{
  "adapterId": "example",
  "name": "Example Parts Store",
  "url": "https://example.com",
  "mode": "http",
  "needsAuth": false,
  "maxRPS": 3,
  "timeout": 15000,
  "retries": 2,
  "tags": ["ru", "commercial"],
  "version": 1,
  "prompt": {
    "customInstructions": null,
    "selectorHints": {},
    "knownIssues": null,
    "apiNotes": null
  }
}
```

Per-site settings (credentials, proxy pool, healthCheckQuery, status, health)
live on the Site record in Mongo — never in meta.json.

See spec section 4 for the full schema.

## E2E tests (mandatory for every adapter)

Each adapter must have `adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import adapter from './adapter.js';
import { createTestContext } from '../../shared/test-helpers/e2e-runner.js';
import meta from './meta.json' with { type: 'json' };

describe(meta.adapterId, () => {
  it('returns at least 1 result for a sample query', async () => {
    const ctx = createTestContext({ siteId: meta.adapterId });
    await adapter.initialize(ctx);
    const results = await adapter.search(ctx, { partNumber: 'TEST' });
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(r.partNumber).toBeTruthy();
      expect(r.brand).toBeTruthy();
      expect(typeof r.price).toBe('number');
      expect(r.source).toBe(meta.adapterId);
    }
  });
});
```

The real `healthCheckQuery` lives on the Site record (per installation) — the
in-tree test uses whatever sample query makes sense for the adapter.

## AI Pipeline flow (automated adapter generation)

When the AI Pipeline service in `interparts-core` processes a generate/fix job:

1. Reads `templates/prompt-generate.md` (or `prompt-fix.md`)
2. Collects context: `meta.json`, fetched HTML/screenshot, previous adapter code (for fix), error text
3. Calls Claude API (sonnet) with sanitized HTML (spec section 19 — prompt injection defense)
4. Extracts TypeScript from Claude's response
5. Validates: `tsc --noEmit` → `CodeValidator` (security scan) → E2E test run
6. On success: `git add adapters/<adapterId>/ && git commit && git push`
7. Workers on the server detect changes via `fs.watch` → hot-swap adapter

The prompt templates use Mustache-style `{{VARIABLE}}` placeholders filled by the pipeline.

## Git conventions

- **Commits by AI Pipeline**: `feat(<adapterId>): auto-generated adapter v<N>` or `fix(<adapterId>): auto-fixed adapter v<N>`
- **Manual commits**: conventional format — `feat(<adapterId>): ...`, `fix(<adapterId>): ...`
- Many AI-generated test adapters (`aigene2e*`) accumulate from E2E test runs — these are harmless and can be cleaned up periodically

## adapter.types.ts sync

`shared/interfaces/adapter.types.ts` is a **copy** of `interparts-core/workers/src/interfaces/adapter.types.ts`.

**The source of truth is in interparts-core.** If the interface changes:
```bash
cp ../interparts-core/workers/src/interfaces/adapter.types.ts shared/interfaces/adapter.types.ts
```

Never edit the copy directly — changes would be overwritten on next sync.

## Common tasks

### Add a new adapter manually
```bash
mkdir -p adapters/newsite
# Create adapter.ts, meta.json, adapter.test.ts
npx tsc --noEmit                              # type check
npx vitest run adapters/newsite/adapter.test.ts  # E2E test
```

### Type-check the whole project
```bash
npx tsc --noEmit
```

### Run all E2E tests
```bash
npx vitest run
```

### Run a single adapter's test
```bash
npx vitest run adapters/demo-http/adapter.test.ts
```

### Clean up leftover AI-generated test adapters
```bash
# Remove adapters created by E2E test runs (aigene2e* prefix)
rm -rf adapters/aigene2e*
git add -A && git commit -m "chore: clean up E2E test adapters"
```

## Spec reference

| Topic | Section |
|-------|---------|
| Adapter contract & interface | 4 |
| Three worker modes — examples | 5 |
| meta.json full schema | 4 |
| AI Pipeline flow + prompts | 9 |
| Prompt injection defense | 19 |
| Rules for AI-generated code | 19 (end) |
| MongoDB adapter schemas | 10.2 |

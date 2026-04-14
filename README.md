# Inter Parts Aggregator — Adapters (`interparts-adapters`)

Адаптеры для ~60 сайтов-поставщиков автозапчастей. Каждый адаптер реализует единый контракт `PartSearchAdapter` и работает в одном из трёх режимов: `api`, `http`, `browser`.

Этот репозиторий отделён от инфраструктуры ([`interparts-core`](https://github.com/william-aqn/interparts-core)), потому что AI Pipeline автоматически коммитит сюда сгенерированный/починенный код — такие автокоммиты не должны засорять историю инфраструктурного кода (см. ТЗ §11).

> **Статус**: рабочий демо-адаптер (`demo-http` → dummyjson.com), AI Pipeline генерирует и чинит адаптеры автоматически через Claude API.

## Структура

```
interparts-adapters/
├── adapters/
│   ├── demo-http/                 # Демо-адаптер (dummyjson.com, mode: http)
│   │   ├── adapter.ts             # Реализация PartSearchAdapter
│   │   ├── adapter.test.ts        # E2E тест (vitest, реальный HTTP)
│   │   └── meta.json              # Конфиг: url, mode, limits, prompt hints
│   ├── demo-api/                  # Демо: API-режим
│   └── demo-browser/              # Демо: Browser-режим (Playwright)
├── shared/
│   ├── interfaces/
│   │   └── adapter.types.ts       # Контракт (КОПИЯ из interparts-core)
│   ├── test-helpers/              # Mock ExecutionContext для тестов
│   └── utils/                     # Общие утилиты парсинга
├── templates/
│   ├── prompt-generate.md         # Mustache-шаблон: промпт для генерации адаптера
│   └── prompt-fix.md              # Mustache-шаблон: промпт для починки адаптера
├── package.json                   # Node >=22, TypeScript 5.6, vitest, cheerio
└── tsconfig.json                  # strict, noUncheckedIndexedAccess, ES2022
```

## Контракт адаптера

Source of truth: `interparts-core/workers/src/interfaces/adapter.types.ts`.
Копия здесь: `shared/interfaces/adapter.types.ts`.

```typescript
import type { PartSearchAdapter } from '../../shared/interfaces/adapter.types.js';

const adapter: PartSearchAdapter = {
  siteId: 'example',
  siteName: 'Example Parts',
  capabilities: { mode: 'http', needsAuth: false, supportsBulkSearch: false,
                  maxRPS: 3, searchByVIN: false, searchByCross: false },

  async initialize(ctx) { /* one-time setup */ },
  async search(ctx, query) { /* returns PartResult[] */ },
  async healthCheck(ctx) { /* quick sanity probe */ },
};

export default adapter;
```

## Три режима

| Mode | Runtime | RAM | Когда |
|------|---------|-----|-------|
| `api` | `ctx.fetch` → JSON | ~100 MB | Сайт имеет JSON API |
| `http` | `ctx.fetch` + Cheerio → HTML | ~150 MB | Простой HTML, без JS |
| `browser` | Playwright `ctx.page` | ~1.5 GB | SPA, AJAX, анти-бот |

**Принцип: всегда минимально достаточный режим.** 90% сайтов — `http`.

## Быстрый старт

```bash
cd interparts-adapters
npm install
npx tsc --noEmit                   # проверка типов
npx vitest run                     # все E2E тесты
npx vitest run adapters/demo-http  # один адаптер
```

## AI Pipeline (автоматическая генерация)

AI Pipeline в `interparts-core` автоматически:
1. Генерирует адаптеры по `templates/prompt-generate.md` + мета-данные сайта + HTML
2. Чинит сломанные по `templates/prompt-fix.md` + ошибки + предыдущий код
3. Валидирует: `tsc` → `CodeValidator` (security) → E2E тест (реальный HTTP)
4. При успехе: `git commit` + `git push` автором `AI Pipeline <ai@interparts.io>`
5. Workers подхватывают через `fs.watch` → hot-swap без рестарта

### Правила безопасности (CodeValidator)

| Запрещено | Почему |
|-----------|--------|
| Обращение к URL вне `meta.json` | Только url + apiNotes из конфига |
| `process.env` (кроме `PLAYWRIGHT_SKIP`) | Изоляция от окружения |
| `eval()`, `new Function()` | Injection prevention |
| `child_process`, `fs.write*`, `net.*` | Песочница |
| Прямой import `http`/`node-fetch`/`axios` | Только `ctx.fetch` |
| Хардкод credentials | Только `ctx.credentials` |

## Файлы адаптера

```
adapters/<siteId>/
  adapter.ts          # Реализация PartSearchAdapter
  adapter.test.ts     # E2E тест (vitest)
  meta.json           # siteId, url, mode, limits, healthCheckQuery, prompt hints
```

### meta.json (минимальный)

```json
{
  "siteId": "example",
  "siteName": "Example Parts",
  "url": "https://example.com",
  "mode": "http",
  "needsAuth": false,
  "maxRPS": 3,
  "timeout": 15000,
  "retries": 2,
  "tags": ["ru"],
  "version": 1,
  "healthCheckQuery": "1K0615301AA",
  "prompt": { "customInstructions": null, "selectorHints": {}, "knownIssues": null, "apiNotes": null }
}
```

## Синхронизация adapter.types.ts

При изменении типов в `interparts-core`:
```bash
cp ../interparts-core/workers/src/interfaces/adapter.types.ts shared/interfaces/adapter.types.ts
```
Никогда не редактировать копию напрямую — source of truth в core.

## Деплой

Workers читают адаптеры из bind mount:
```
/opt/interparts-adapters/adapters:/app/adapters:ro
```
Push в этот репо → GitHub Action → `git pull` на сервере → workers подхватывают через `fs.watch` (hot-swap).

## Лицензия

MIT. См. `LICENSE`.

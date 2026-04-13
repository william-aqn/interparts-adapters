# CLAUDE.md — guidance for Claude sessions on `interparts-adapters`

> Этот файл — ориентир для Claude-агентов (включая AI Pipeline в Phase 4+), которые будут генерировать, чинить и поддерживать адаптеры.

## Проект

Адаптеры для ~60 сайтов-поставщиков автозапчастей в рамках Inter Parts Aggregator.
Полное ТЗ: `../interparts-info/README.md` (если доступен локально).
Инфраструктура: [`interparts-core`](https://github.com/william-aqn/interparts-core).

## Жёсткие правила для адаптеров

**Безопасность (критично — в Phase 4 будет проверяться CodeValidator):**
- НЕ обращаться ни к каким URL, кроме указанных в `meta.json` (поле `url` + явно описанные в `prompt.apiNotes`)
- НЕ читать `process.env` (кроме `PLAYWRIGHT_SKIP` и `NODE_OPTIONS`)
- НЕ использовать `eval()`, `new Function()`, `child_process`, `fs.write*`, `net.*`, `dgram.*`
- НЕ импортировать `http`, `https`, `node-fetch`, `axios`, `got` напрямую — все HTTP ТОЛЬКО через `ctx.fetch`
- Все credentials — ТОЛЬКО через `ctx.credentials` (никогда в коде)
- НЕ писать файлы — только читать HTML и возвращать `PartResult[]`

**Типизация:**
- `strict: true` обязателен
- Никаких `any`, используй `unknown` + type guards
- Каждое поле `PartResult` (price, quantity) — парсить как число, не строку

**Ошибки и логирование:**
- Try/catch с понятными сообщениями
- Логирование через `ctx.logger` (info, warn, error)
- Таймауты: `AbortController` для fetch, `timeout` для Playwright

**Поля результата:**
- `source` всегда = siteId из meta.json
- `updatedAt` = `new Date()`
- `currency` — ISO 4217 (RUB, USD, EUR, KZT)
- Не выдумывай данные — если поле недоступно, оставь `undefined`

## Контракт (`adapter.types.ts`)

Читай из `shared/interfaces/adapter.types.ts`. Это КОПИЯ из `interparts-core/workers/src/interfaces/`. Не меняй локально — только в source.

Экспорт адаптера:
```typescript
import type { PartSearchAdapter } from '../../shared/interfaces/adapter.types.js';

const adapter: PartSearchAdapter = {
  siteId: 'example',
  siteName: 'Example Site',
  capabilities: { mode: 'http', needsAuth: false, ... },

  async initialize(ctx) { /* ... */ },
  async search(ctx, query) { /* ... */ },
  async healthCheck(ctx) { /* ... */ },
};

export default adapter;
```

## Файловая структура адаптера

```
adapters/
  <siteId>/
    adapter.ts        # реализация PartSearchAdapter
    adapter.test.ts   # E2E тест (реальный HTTP запрос)
    meta.json         # конфиг
```

## meta.json — минимальный пример

```json
{
  "siteId": "example",
  "siteName": "Example Site",
  "url": "https://example.com",
  "mode": "http",
  "needsAuth": false,
  "maxRPS": 3,
  "timeout": 15000,
  "retries": 2,
  "tags": ["demo"],
  "version": 1,
  "healthCheckQuery": "test-part-number",
  "prompt": {
    "customInstructions": null,
    "selectorHints": {},
    "knownIssues": null,
    "apiNotes": null
  }
}
```

См. ТЗ §4 для полной схемы.

## Режимы (выбор)

| Mode | Когда | Библиотеки (доступны через ctx) |
|------|-------|----------------------------------|
| `api` | Сайт имеет JSON API | `ctx.fetch` |
| `http` | Простой HTML без JS | `ctx.fetch`, `ctx.parseHtml` (Cheerio) |
| `browser` | SPA, AJAX, анти-бот | `ctx.page`, `ctx.browserContext` (Playwright) |

Принцип: **всегда минимальный достаточный**. Если `fetch(url)` возвращает нужный HTML — не используй Playwright.

## E2E тесты — обязательно

Каждый адаптер должен иметь `adapter.test.ts`, который:
1. Импортирует адаптер
2. Создаёт minimal mock `ExecutionContext` с реальным fetch
3. Вызывает `adapter.search(ctx, { partNumber: meta.healthCheckQuery })`
4. Проверяет: результат ≥ 1 `PartResult`, все обязательные поля заполнены

Тесты пишутся в `vitest`. Запуск: `npx vitest run`.

## Для AI Pipeline (Phase 4+)

Когда AI Pipeline будет генерировать или чинить адаптер:
1. Читает `templates/prompt-generate.md` или `templates/prompt-fix.md`
2. Собирает контекст: `meta.json`, HTML, screenshot, предыдущий код
3. Вызывает Claude API (sonnet) с санитизированным HTML (см. ТЗ §19)
4. Извлекает код из ответа, прогоняет через `tsc` + `CodeValidator` + E2E
5. При успехе: `git add adapters/<siteId>/ && git commit && git push`
6. Workers на сервере подхватывают через `fs.watch` → hot-swap

## Часто встречающиеся задачи

### Добавить новый адаптер вручную (для тестирования)
```bash
mkdir -p adapters/newsite
# Создать adapter.ts, meta.json, adapter.test.ts
npx tsc --noEmit
npx vitest run adapters/newsite/adapter.test.ts
```

### Проверить типы во всём проекте
```bash
npx tsc --noEmit
```

### Прогнать все тесты
```bash
npx vitest run
```

### Синхронизировать adapter.types.ts после изменения в core
```bash
cp ../interparts-core/workers/src/interfaces/adapter.types.ts shared/interfaces/adapter.types.ts
```

## Ссылки на ТЗ

| Тема | Раздел |
|------|--------|
| Контракт адаптера | §4 |
| Три режима — примеры | §5 |
| meta.json — полная схема | §4 |
| AI Pipeline + промпты | §9 |
| Защита от prompt injection | §19 |
| Правила для AI-генерации | §19 (конец) |

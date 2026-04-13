# Inter Parts Aggregator — Adapters (`interparts-adapters`)

Адаптеры для ~60 сайтов-поставщиков автозапчастей. Каждый адаптер реализует единый контракт `PartSearchAdapter` и работает в одном из трёх режимов: `api`, `http`, `browser`.

Этот репозиторий — отдельный от инфраструктуры ([`interparts-core`](https://github.com/william-aqn/interparts-core)). Причина разделения: AI Pipeline автоматически коммитит сюда сгенерированный/починенный код — такие автокоммиты не должны засорять историю инфраструктурного кода (см. ТЗ §11).

## Структура

```
interparts-adapters/
├── adapters/
│   └── demo-http/               # Phase 1: один демо-адаптер через dummyjson.com
│       ├── adapter.ts
│       ├── adapter.test.ts
│       └── meta.json
├── shared/
│   ├── interfaces/
│   │   └── adapter.types.ts     # Копия из interparts-core (source of truth)
│   ├── utils/                   # Вспомогательные функции (phase 2+)
│   └── test-helpers/            # E2E runner (phase 4)
├── templates/
│   ├── prompt-generate.md       # Шаблон для AI: генерация нового адаптера (phase 4)
│   └── prompt-fix.md            # Шаблон для AI: починка сломанного адаптера (phase 4)
└── .github/workflows/
    └── deploy-adapters.yml      # SSH + git pull на сервере
```

## Контракт адаптера

Source of truth — `interparts-core/workers/src/interfaces/adapter.types.ts`.
Копия в этом репо — `shared/interfaces/adapter.types.ts`.

Главный интерфейс:

```typescript
interface PartSearchAdapter {
  readonly siteId: string;
  readonly siteName: string;
  readonly capabilities: AdapterCapabilities;  // mode, needsAuth, maxRPS, etc.

  initialize(ctx: ExecutionContext): Promise<void>;
  authenticate?(ctx: ExecutionContext): Promise<void>;
  search(ctx: ExecutionContext, query: PartQuery): Promise<PartResult[]>;
  getPartDetails?(ctx: ExecutionContext, partNumber: string): Promise<PartDetails>;
  checkAvailability?(ctx: ExecutionContext, partNumbers: string[]): Promise<Map<string, AvailabilityStatus>>;
  healthCheck(ctx: ExecutionContext): Promise<HealthStatus>;
}
```

Каждый адаптер:
- Default-экспортирует объект, реализующий этот интерфейс
- Имеет `meta.json` с конфигом (`siteId`, `mode`, `needsAuth`, `maxRPS`, ...)
- Имеет `adapter.test.ts` — E2E тест с реальным запросом

## Три режима адаптера

| Mode | Runtime | Dockerfile | RAM | Когда использовать |
|------|---------|-----------|-----|--------------------|
| `api` | `ctx.fetch` → JSON | Dockerfile.light | ~100 MB | Сайт предоставляет публичный/дилерский API |
| `http` | `ctx.fetch` → HTML + Cheerio | Dockerfile.light | ~150 MB | Простая HTML-страница без JS-рендеринга |
| `browser` | Playwright `ctx.page` | Dockerfile.browser | ~1.5 GB | SPA, JS-рендеринг, AJAX, анти-бот защита |

Принцип: **всегда выбирай минимально достаточный режим**. 90% сайтов должны работать через `http`.

## Быстрый старт

```bash
cd interparts-adapters
npm install
npx tsc --noEmit           # проверка типов
npx vitest run             # запуск тестов (включая E2E demo-http → dummyjson.com)
```

## Демо-адаптер (Phase 1)

`adapters/demo-http/` — минимальный рабочий адаптер через публичный JSON API dummyjson.com. Не требует credentials, стабилен, демонстрирует полный контур:

```
BullMQ task → Worker → AdapterLoader → demo-http.search() → ctx.fetch(dummyjson) → PartResult[]
```

Использование для верификации Phase 1:
```bash
npx vitest run adapters/demo-http/adapter.test.ts
```

## Взаимодействие с AI Pipeline (Phase 4+)

В будущем AI Pipeline будет:
1. Генерировать новые адаптеры по `templates/prompt-generate.md`
2. Чинить сломанные адаптеры по `templates/prompt-fix.md`
3. Коммитить результат с автором `AI Pipeline <ai@interparts.io>`

Каждый коммит от AI проходит через:
- `tsc --noEmit` — проверка типов
- `CodeValidator` — защита от prompt injection (см. ТЗ §19)
- E2E тест — реальный запрос к сайту поставщика
- Только при успехе всех трёх — `git commit + push`

## Синхронизация `adapter.types.ts`

Пока вручную (Phase 1). В Phase 6 — GitHub Action автоматически создаёт PR при изменении типов в `interparts-core`.

**Если нужно изменить типы:**
1. Обновить в `interparts-core/workers/src/interfaces/adapter.types.ts`
2. Скопировать в `interparts-adapters/shared/interfaces/adapter.types.ts`
3. Коммитить в ОБА репо с одинаковым сообщением

## Деплой

Workers на сервере читают адаптеры из `/opt/interparts-adapters/adapters:/app/adapters:ro` через bind mount. Любое изменение в этом репо → GitHub Action → `git pull` на сервере → workers подхватывают через `fs.watch` (hot-swap).

## Лицензия

MIT. См. `LICENSE`.

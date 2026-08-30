# REMCOD Agent Runtime

Provider-neutral open-source runtime и test harness для автономных агентов. Текущий
реализованный срез — локальная in-memory основа Phase 0 + Phase 1: protocol v1,
agent/model/tool contracts, ограниченный model/tool loop, event store, NDJSON/HTTP
transport, deterministic testing, curated SDK и runnable example. Production
durability, PostgreSQL store, policy engine, browser/computer control, scheduler,
multi-agent orchestration, deployment и public release пока отсутствуют.

## Стек и проверенное состояние

- Node.js `24.15.0` (`.node-version`), pnpm `11.24.0` (`packageManager`), ESM,
  TypeScript `7.0.2` в strict `NodeNext`, Zod `4.5.4`, Vitest/coverage `4.1.11`,
  OpenTelemetry API `1.9.1`.
- Exact-state проверен: frozen install зелёный; `pnpm check` зелёный — 28 Node
  tests + 75 Vitest tests; source coverage — 87% statements, 75.92% branches,
  92.19% functions, 89.32% lines; build зелёный; export smoke — 16 targets и 7
  public imports; basic example печатает ровно `{"answer":42}`; license check зелёный.
- Полная проверка из корня: `pnpm check && pnpm legal:licenses`. Важно:
  `pnpm check` уже включает format, lint, typecheck, tests, coverage, build и export
  smoke, но **не** включает license audit.
- Воспроизводимая установка: `pnpm install --frozen-lockfile`.
- Раздельные команды: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
  `pnpm test`, `pnpm test:coverage`, `pnpm build`, `pnpm smoke:exports`,
  `pnpm legal:licenses`.
- Basic example на fresh clone: `pnpm build && pnpm --filter
  @remcod/example-basic-agent build && pnpm --filter @remcod/example-basic-agent start`.

## Структура и ключевые файлы

| Область | Файлы | Фактическая роль |
|---|---|---|
| workspace | `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.config.mjs` | root scripts, package graph, TypeScript и coverage |
| protocol | `packages/protocol/src/{ids,json,records,states,events,errors,json-schema}.ts` | JSON-only wire contract v1 и JSON Schema |
| core | `packages/core/src/{agent,limits,retry,compaction,defaults}.ts` | agent definitions, budgets, retry и compaction contracts |
| model seam | `packages/model-router/src/index.ts` | `ModelProvider`, normalized request/response, exact provider registry |
| tools | `packages/tools/src/index.ts` | typed definitions, Zod validation, risk, timeout и abort envelope |
| runtime | `packages/runtime/src/{runtime,store,reducer}.ts` | execution loop, in-memory CAS/event store, pure reducer |
| transport | `packages/runtime/transport/index.ts` | validated NDJSON и framework-neutral HTTP handler |
| testing | `packages/testing/src/index.ts` | deterministic `ScriptedModel` |
| SDK | `packages/sdk/src/index.ts` | curated public re-exports; leaf facade |
| example | `examples/basic-agent/src/{index,run}.ts` | внешний consumer: model → `add` tool → terminal JSON |
| guardrails | `scripts/{check-governance,smoke-exports}.mjs`, `tests/workspace-governance.test.mjs` | privacy/import/secret/license scan и public-export smoke |
| docs | `docs/architecture/overview.md`, `docs/concepts/runtime-model.md`, `docs/reference/{public-api,protocol-v1}.md` | актуальные boundaries и public contracts |

Реальные workspace packages: `@remcod/protocol`, `@remcod/core`,
`@remcod/model-router`, `@remcod/tools`, `@remcod/runtime` (и explicit subpath
`@remcod/runtime/transport`), `@remcod/testing`, `@remcod/sdk`, а также
`@remcod/example-basic-agent`. Остальные каталоги в `packages/`, `apps/` и `examples/`
с одним README — roadmap placeholders, не скрытая реализация и не готовые build
targets.

## Архитектура и направление зависимостей

```text
protocol          -> zod
tools             -> protocol, zod
core              -> protocol, tools, zod
model-router      -> core, protocol
runtime           -> core, model-router, protocol, tools, zod
runtime/transport -> protocol, runtime
testing           -> model-router, protocol
sdk               -> все public packages, zod
```

- Cross-package imports идут только через package exports. Deep imports запрещены;
  единственный поддержанный subpath — `@remcod/runtime/transport`. Ни один
  implementation package не зависит от `@remcod/sdk`.
- `@remcod/protocol` единолично владеет wire-формами `Usage` и `ToolCall`;
  model-router переэкспортирует canonical types, не заводит дубликаты.
- Zod schemas — runtime source of truth; TypeScript types inferred, JSON Schema
  генерируется через `generateProtocolJsonSchemas()`. Protocol literal — `"1"`,
  persisted/model/tool payloads — только `JsonValue`.
- Public seams: `ModelProvider.generate(request, { signal })`, `RuntimeStore`
  CAS/event/idempotency methods и `ToolDefinition.execute(input, context)`.
  Тестировать поведение следует через public API и эти seams.

## Data flow runtime

1. `createRuntime(config)` делает immutable snapshot явного `agents` registry и
   отклоняет duplicate agent IDs и duplicate tool names. Global/environment agent
   registry отсутствует.
2. `createSession({ agentId })` делает exact agent lookup, создаёт idle session и
   атомарно сохраняет `session.created`. Unknown agent fail closed.
3. `runTurn` валидирует JSON input/version, переводит session/turn в running,
   собирает bounded context и вызывает exact provider из `ProviderRegistry`.
4. `message` завершает step/turn/session; `tool_calls` исполняются последовательно,
   outputs возвращаются следующему model request. Успешный Phase 1 turn завершает и
   session; публичного continuation/replay/time-travel API нет.
5. Все изменения session/events идут через store CAS/cursor operations. Pure
   `reduceRuntimeEvents` восстанавливает session, turns, steps и counters, но не
   вызывает provider/tool и не является durability/replay обещанием.
6. `runtime.events()` читает уже сохранённую историю страницами; transport валидирует
   events и отдаёт NDJSON. Consumer abort закрывает iterator, но не отменяет session.

## Protocol, store и execution invariants

- Branded IDs создаются через `createId`; строки не могут быть пустыми/whitespace.
  `Session`, `Turn`, `Step`, events и errors проходят strict Zod validation.
- State transitions задаются только `canTransitionSession`,
  `canTransitionTurn`, `canTransitionStep`; terminal states не имеют исходящих
  переходов. При отмене running step сначала пишется `step.cancelled`, затем
  terminal turn/session cancellation.
- Cursor отдельный для каждой session, contiguous, начинается с 1;
  `afterCursor` exclusive. CAS version/cursor conflict typed и не оставляет
  partial append. Store возвращает defensive structured clones.
- `createInMemoryRuntimeStore()` теряет всё при рестарте процесса. Его cursor
  reconnect, serialization и idempotency не означают crash recovery или
  distributed coordination.
- Tool idempotency использует atomic
  `claimIdempotency(scope,key,fingerprint)` → `claimed | in_flight | completed |
  conflict`; fingerprint связывает provider call ID с canonical tool name+input.
  JSON `null` — валидный cached result, не miss sentinel. Неясный in-flight effect
  остаётся fail-closed и не повторяется автоматически.
- Hard limits: steps/model calls/tool calls/input tokens/output tokens. Defaults:
  32/16/64/100000/16000; значения только finite non-negative integers.
- Provider retry по умолчанию: максимум 3 попытки, только для ошибок с
  `retryable: true`, exponential delay с cap. Tool effects runtime автоматически
  не retry.
- Tool risk: `read | draft | write | privileged`; Phase 1 исполняет только `read`
  и `draft`, а `write`/`privileged` возвращают `POLICY_REQUIRED`.
- `defineTool` immutable-snapshot'ит definition, валидирует timeout и JSON-output
  representability. Author получает normalized `z.output<InputSchema>` и возвращает
  raw `z.input<OutputSchema>`; output нормализуется один раз, cached output только
  structural-валидируется и не transform/decode повторно.
- Один caller-or-timeout `AbortSignal` покрывает input validation, implementation и
  output validation. Invalid timeout → `InvalidToolTimeoutError`, expiry →
  `ToolTimeoutError`.
- `ScriptedModel` не требует сети/API keys: successful call потребляет ровно один
  script item; plain data и request journal snapshot'ятся; identity `Error` и
  `AbortSignal` сохраняется; aborted call не потребляет item; `assertExhausted()`
  закрывает expected interaction.

## Transport contract

- Endpoint: `GET /v1/sessions/:sessionId/events?afterCursor=N&limit=N`.
- Success — `200 application/x-ndjson; charset=utf-8`; unknown route/session —
  404 problem JSON; unsupported method — 405 + `Allow: GET`; invalid URL/query —
  400; typed version/cursor conflict — 409; unknown internal error — sanitized 500.
- `afterCursor` default 0 и exclusive; `limit` default 1000 и clamp 1..1000;
  duplicate/unknown query keys отвергаются. Encoder выдаёт один compact validated
  event плюс newline и уважает backpressure.

## Соглашения и boundaries проекта

- Название проекта — `REMCOD Agent Runtime`, GitHub-репозиторий —
  `remcod-ru/remcod-agent-runtime`, workspace scope — `@remcod/*`. Все
  workspace packages пока `private: true`, версии `0.0.0` не опубликованы. Не
  публиковать npm/release, не создавать deployment и не снимать private без
  отдельного решения и human package/legal review. Лицензия репозитория —
  Apache-2.0.
- Реализация provider-neutral и clean-room. Core не импортирует product-specific
  runtimes, vendor SDK или чужой runtime source. Совместимость с внешними
  продуктами принадлежит будущим adapters, не core.
- Organization scope, authorization, trusted principal, approval workflows,
  credentials и secrets не берутся из model output и не входят в Phase 1
  model/runtime context.
- Новая dependency требует exact pin и maintainer review. Governance scanner
  fail-closed проверяет package privacy, secret patterns и bare imports/dependencies
  `packages/core`; source imports используют `.js` suffix под `NodeNext`.
- Изменение начинается failing test на public seam → минимальная реализация →
  refactor → targeted checks → root checks. При изменении behavior/public boundary
  документация обновляется в том же change. Не коммитить `node_modules/`, `dist/`,
  `coverage/`, credentials или private data.
- Environment names only: `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_PORT`. Phase 1 не требует env, API key, network service, database или
  Docker. `compose.yaml` — только статический reference seam будущего PostgreSQL
  store; текущий runtime DB driver не импортирует.

## Тесты и точечные команды

- Root governance Node test: `node --test tests/workspace-governance.test.mjs`.
- Один Vitest-файл: `pnpm exec vitest run packages/runtime/src/runtime.test.ts`.
- Store: `pnpm exec vitest run packages/runtime/src/store.test.ts`.
- Runtime contracts: `pnpm exec vitest run packages/runtime/src/runtime-contracts.test.ts`.
- Transport: `pnpm exec vitest run packages/runtime/transport/transport.test.ts`.
- Protocol events: `pnpm exec vitest run packages/protocol/tests/events.test.ts`.
- Basic example: `pnpm exec vitest run examples/basic-agent/src/index.test.ts`.
- Package: `pnpm --filter @remcod/runtime test` (аналогично для остальных package names).
- JSON Schema fixture обновляется только осознанно:
  `pnpm --filter @remcod/protocol schema:fixture`; затем проверить diff fixture и
  protocol parity test.
- Governance CLI: `node scripts/check-governance.mjs [--root <directory>]
  [--licenses] [--license-report <file>]`; export smoke:
  `node scripts/smoke-exports.mjs [--root <directory>]`.

## Реальные gotchas

- Green `pnpm check` не даёт license verdict; нужен отдельный
  `pnpm legal:licenses`. Автоматический scan — guardrail, не замена human legal,
  NOTICE, provenance, trademark и brand review перед публикацией.
- Export smoke проверяет существование built targets и importability public packages;
  он требует актуального `dist/`, но `dist/` — generated output и не коммитится.
- Root `pnpm test` сначала запускает Node governance suite, затем Vitest. Coverage
  считает только `packages/*/src` и `packages/runtime/transport`, исключая root
  governance test и `dist`.
- Каталог с README без `package.json` — placeholder. Не добавлять туда behavior и не
  объявлять feature реализованной, пока нет package/public tests/docs.
- In-memory append-only trace не durable store; NDJSON reconnect не restart recovery;
  pure reducer не public replay; idempotency record не distributed recovery protocol.
- Stream disconnect не cancel session. Tool timeout/caller abort и runtime session
  cancellation — отдельные boundaries.
- `ProviderRegistry.resolve` и agent lookup exact, без fallback. Duplicate IDs/names,
  unknown provider/agent, conflicting idempotency fingerprint и ambiguous in-flight
  reuse должны оставаться fail-closed.
- Не декодировать/transform tool output повторно при cache hit и не считать cached
  `null` отсутствующим значением.

# Отчёт: Phase 6 — политики и HITL-подтверждения в REMCOD Agent Runtime

**Дата:** 2026-11-13
**Ветка:** `feat/policy-capability-approvals`
**PR:** [remcod-ru/remcod-agent-runtime#78](https://github.com/remcod-ru/remcod-agent-runtime/pull/78) (draft)
**Коммиты:** `ca5eb1b`, `b79cd0e`, `1db5e49`, `417c597`

## 1. Зачем

Рантайм отказывал любому `write`/`privileged` вызову с `POLICY_REQUIRED` до
исполнения. Это безопасно, но означает, что ни одна продуктовая мутация (смета,
счёт, задача) не может пройти через рантайм. Для замены Eve нужен контур, в
котором:

- модель предлагает действие, но **не выдаёт себе право** на него;
- человек (доверенный principal) подтверждает **точное** действие, а не «инструмент
  вообще»;
- подтверждение нельзя переиспользовать, подменить вход или протащить старую
  политику;
- отказ, истечение и несовпадение привязки падают fail-closed.

## 2. Что реализовано

### Коммит `ca5eb1b` — пакет `@remcod/policy` и интеграция в рантайм

- `canonicalJson` + `digestToolAction`: детерминированный sha256 от
  `{ input, toolName }` (своя SHA-256, без Node-специфичных зависимостей).
- `createPolicyEngine`: правила `allow` / `deny` / `require_approval`, первый
  совпавший по имени инструмента выигрывает; дефолт fail-closed — `read` и `draft`
  разрешены, `write`/`privileged` требуют подтверждения.
- `createApprovalLedger`: подтверждение привязано к сессии, инструменту и дайджесту
  входа, расходуется один раз; pending/denied/expired/повтор — типизированные
  ошибки.
- `createRuntime({ policy, approvals })`: проверка политики идёт **до** валидации
  входа и идемпотентности. `deny` и «отвергнуто/истекло» → существующий
  `POLICY_REQUIRED` с машинной причиной в `details` (протокол остался v1);
  отсутствие подтверждения → парковка (см. ниже).
- Без `policy` поведение Phase 1 сохраняется бит-в-бит.

### Коммит `b79cd0e` — привязка к политике и валидация риска

- `PolicyAction` несёт `policyVersion` и `policyDigest`; движок отвергает действие,
  собранное под другой ruleset; ledger матчит только подтверждение с тем же
  дайджестом. Смена правил инвалидирует ранее выданные подтверждения.
- `defineTool` валидирует `risk` в рантайме (`InvalidToolRiskError`): JS-вызов не
  может объявить неизвестный риск и попасть в «не сайд-эффект» ветку политики.
  Источник истины — `ToolRiskSchema` в `@remcod/tools`.

### Коммит `1db5e49` — извлечение turn machine (без изменения поведения)

Цикл модели/инструментов вынесен из `#runRegisteredTurn` в `#runLoop` над явным
`TurnMachine` (session, turn, agent, provider, limits, counters, messages, шаг).
Протокол не хранит ответ модели с `tool_calls`, поэтому продолжить припаркованный
turn можно только из состояния в памяти — это и есть шов для резюме.
Эквивалентность доказана: 28 контрактных тестов прошли без правок.

### Коммит `417c597` — парковка и резюме подтверждений

- Нет подходящего подтверждения → turn паркуется в `waiting_input`:
  `tool.failed` + `step.failed` + `input.requested` (с точной привязкой: инструмент,
  риск, дайджест входа, дайджест политики, срок), `runTurn` возвращает
  `pendingApproval`. Инструмент не запускается, заявка на идемпотентность не
  создаётся.
- `resumeTurn`: pending — типизированный отказ **без записи событий**; denied и
  expired — отмена сессии fail-closed (`input.received` + `session.cancelled`);
  approved — `input.received`, `waiting_input → running` и продолжение того же turn
  и `toolCallId`, где подтверждение расходуется ровно один раз.
- `runTurn` при наличии парковки отвергается (`INVALID_TRANSITION`,
  `reason: approval_pending`) — обойти решение новым ходом нельзя.
- `cancelSession` сбрасывает продолжение; резюме после отмены невозможно.

## 3. Поток решения

```text
model tool_calls
  → policy.evaluate(action)            # чистая детерминированная функция
      deny            → POLICY_REQUIRED (fail-closed), turn падает
      require_approval
          есть approval → ledger.consume(action) один раз → выполнить
          нет           → park: waiting_input + input.requested + pendingApproval
  → principal: approvals.decide(requestId, { approved })
  → resumeTurn
      pending  → отказ, событий нет
      denied   → session.cancelled, fail-closed
      expired  → session.cancelled, fail-closed
      approved → input.received → running → consume → выполнить → продолжить модель
```

## 4. Инварианты безопасности (доказаны тестами)

1. Модель не может выдать себе право: решение зависит только от объявленного
   `risk` инструмента, входа и документа политики, который задаёт хост.
2. Подтверждение привязано к точному действию: другой вход, инструмент, сессия
   или ruleset не совпадают.
3. Одно подтверждение — одно исполнение.
4. Отказ, истечение, несовпадение и уже израсходованное подтверждение не дают
   исполнения ни при каких условиях.
5. Пока решение не принято, `runTurn` создать новый ход не может.

## 5. Проверка

| Что                                                                          | Результат                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm check` (format, lint, typecheck, build, tests, coverage, export smoke) | зелёный                                                                  |
| `pnpm legal:licenses`                                                        | `governance checks passed`                                               |
| `packages/policy/src/index.test.ts`                                          | 19 тестов                                                                |
| `packages/runtime/src/policy.test.ts`                                        | 6 тестов                                                                 |
| `packages/runtime/src/approvals.test.ts`                                     | 6 тестов (парковка, pending-резюме, одобрение, отказ, истечение, отмена) |
| `packages/runtime/src/runtime-contracts.test.ts`                             | 28 тестов без правок                                                     |
| `packages/tools/src/index.test.ts`                                           | 12 тестов (включая неизвестный риск)                                     |
| Export smoke                                                                 | 18 targets, 8 public imports                                             |
| Покрытие `runtime.ts`                                                        | 88.32% statements, 90.72% lines                                          |

## 6. Окружение (локальный запуск)

- Node `24.15.0` и pnpm `11.24.0` поставлены рядом (`E:\Tools\node-v24.15.0`,
  `E:\Tools\node24-global`); системный Node не менялся.
- Рабочее дерево нормализовано на LF: `core.autocrlf=true` ломал
  `prettier --check` на всех файлах.
- `scripts/check-governance.mjs` не мог запустить `pnpm` на Windows — исправлено
  (запуск через `ComSpec` без `shell: true`).

## 7. Ограничения и риски

- **Продолжение парковки живёт в памяти.** Рестарт процесса теряет parked turn,
  `resumeTurn` падает fail-closed. Это нужно закрыть в Phase 2 (durable store и
  continuation) до продакшена.
- **Ledger тоже в памяти.** Решения не переживают рестарт; аудит-поток решений —
  Phase 9.
- **Бюджет инструментов:** parked-вызов списывает по попытке в `maxToolCalls`
  дважды (при постановке и при резюме). Осознанно, но требует решения продукта.
- **Протокол без изменений:** новых событий и кодов ошибок нет, поэтому старые
  читатели валидны; цена — allow-аудит не попадает в event log.
- **Нет HTTP-маршрута** approve/resume: хосту нужен доступ к ledger и
  `resumeTurn` в процессе рантайма.

## 8. Что осталось (следующие шаги)

1. **Phase 2 — durable runtime:** PostgreSQL store, checkpoints, continuation,
   восстановление парковки и решений после рестарта.
2. **Phase 3 — адаптер совместимости с Eve:** независимо снятые трассы,
   контрактное подмножество, read-only shadow mode, поэтапный переключатель — то,
   что позволяет перевести продукт без переписывания веб/iOS.
3. Остаток Phase 6: L0–L5 автономия, Secret Broker, escalation, emergency stop,
   аудит-поток решений.

## 9. Как ревьюить

- Начать с `docs/adr/0008-policy-and-capability-approvals.md` — там решение и
  отвергнутые альтернативы.
- Затем `packages/policy/src/index.ts` (чистая логика) и
  `packages/runtime/src/approvals.test.ts` (поведение).
- В `packages/runtime/src/runtime.ts` смотреть `#runLoop`, `#executeTools` (ветка
  парковки), `#resumeParkedTurn`, `#parkApproval`.
- Отдельно проверить: семантику парковки вместо падения на mismatch, двойной
  расход бюджета, отсутствие событий при pending-резюме.

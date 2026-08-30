# ADR-0005: Fail-closed граница побочных эффектов

- Status: Accepted
- Date: 2026-08-30

## Контекст

Model provider управляет именем tool, аргументами и `toolCallId`, но не является trusted authority. Сбой после внешнего эффекта и до записи результата оставляет неоднозначность: повтор может удвоить платёж, сообщение или другую мутацию. В текущей фазе ещё нет Capability Gateway, Policy Engine и version-bound approval.

## Решение

Runtime исполняет по умолчанию только tools риска `read` и `draft`; `write` и `privileged` возвращают `POLICY_REQUIRED`. Каждый допустимый вызов получает стабильный idempotency key, атомарный claim и fingerprint из tool name и canonical input. Повтор с тем же key возвращает только уже completed JSON; другой fingerprint конфликтует. Состояние `in_flight` после неоднозначного результата остаётся fail-closed. Runtime не делает автоматический retry tool calls; retries относятся только к классифицированным transient provider failures до принятого ответа.

## Почему

Отвергнуто доверие к risk или authority из model output: цена — LLM может выдать себе права. Отвергнут общий at-least-once retry для provider и tools: он повышает доступность, но цена неоднозначного сбоя — повторный внешний эффект. Отвергнута идемпотентность только по provider-controlled `toolCallId`: переиспользование ID с другими аргументами тогда меняет смысл уже подтверждённого действия. Отвергнуто делегирование policy каждой реализации tool: цена — разные гарантии и обход общего audit boundary. Цена выбранного решения — часть операций останется заблокированной или `in_flight` до появления recovery и policy механизмов.

## Последствия

Интеграторы не могут включить mutation tools одной сменой risk label: Phase 6 должна предоставить детерминированную policy/approval границу. Tool implementations обязаны принимать idempotency context и возвращать валидируемый JSON. Неоднозначность предпочитает ручное или durable recovery автоматическому повтору, поэтому безопасность выше доступности.

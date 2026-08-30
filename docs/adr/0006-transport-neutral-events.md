# ADR-0006: Transport-neutral события и NDJSON-адаптер

- Status: Accepted
- Date: 2026-08-30

## Контекст

Runtime events нужны одновременно локальному SDK, HTTP consumers и будущему durable store. Если wire format или сетевой framework становится форматом хранения или частью core, замена транспорта меняет execution semantics. Разрыв клиента также не должен останавливать автономную session.

## Решение

Канонический поток — `AsyncIterable<RuntimeEvent>`. NDJSON кодирует уже валидированные события по одному JSON object на строку и остаётся transport adapter, а не storage format. Backpressure следует consumer pulls; abort или disconnect закрывает только iteration и не отменяет session. Reference HTTP contract использует нейтральные request/response types, exclusive `afterCursor` и ограниченный `limit`, не импортируя server framework.

## Почему

Отвергнуто хранение NDJSON bytes как canonical log: оно упрощает передачу файла, но цена — transport encoding становится миграцией storage и затрудняет schema-aware queries. Отвергнуты WebSocket или SSE как core API: они дают больше сетевых возможностей, но цена — framework lifecycle, buffering и reconnect semantics проникают в runtime. Отвергнуто автоматическое cancellation session при disconnect: это удобно для request-scoped jobs, но цена — автономная работа зависит от нестабильности клиента. Цена выбранного решения — нужны отдельные adapters и явное преобразование protocol errors в transport responses.

## Последствия

HTTP, NDJSON и будущие transports не владеют состоянием runtime. Медленный consumer не блокирует append событий, а reconnect начинается после последнего обработанного cursor. Новый transport обязан сохранять порядок и validation semantics, но может независимо выбирать framing, flush и механизм backpressure.

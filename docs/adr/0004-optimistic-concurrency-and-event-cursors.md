# ADR-0004: Оптимистическая конкуренция и монотонные event cursors

- Status: Accepted
- Date: 2026-08-30

## Контекст

Одну session могут одновременно продолжить несколько callers, а события должны читаться с reconnect без повторов и пропусков. Простая перезапись текущего Session или append без проверки позиции делает порядок зависимым от timing и позволяет потерять переход состояния.

## Решение

RuntimeStore использует compare-and-set по `Session.version` и append по ожидаемому cursor. Успешная запись назначает внутри session непрерывно возрастающие cursors, начиная с 1; пустой store использует cursor 0. Переход session и соответствующие события сохраняются атомарно, а конфликт версии или cursor возвращается как typed conflict, не разрешается last-write-wins. Публичное чтение использует exclusive `afterCursor` и bounded limit.

## Почему

Отвергнут last-write-wins: он проще, но его цена — тихо потерянные turns и аудит, который не объясняет итоговое состояние. Отвергнут process-wide mutex как публичная гарантия: он не переносится на PostgreSQL, несколько процессов и crash recovery; цена — переделка store contract в Phase 2. Отвергнут timestamp как позиция потока: совпадения и clock skew не дают строгого порядка; цена — дубликаты или пропуски при reconnect. Цена выбранного решения — caller должен обрабатывать конфликты, а durable store обязан реализовать атомарность и строгую последовательность cursor.

## Последствия

Конкурирующие writers получают явный `VERSION_CONFLICT` или `CURSOR_CONFLICT`; runtime не угадывает порядок за них. Consumers могут продолжать чтение после последнего подтверждённого cursor. Реализации store проходят conformance tests на CAS, атомарный append, cursor monotonicity и defensive isolation.

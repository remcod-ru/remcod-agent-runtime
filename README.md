<p align="center">
  <img src="docs/assets/brand/remcod-agent-runtime-cover.png" alt="Обложка REMCOD Agent Runtime" width="100%">
</p>

<h1 align="center">REMCOD Agent Runtime</h1>

<p align="center"><strong>Надёжная среда выполнения ИИ-агентов.</strong></p>

<p align="center">
  Независимое от провайдеров ядро и тестовый контур для создания автономных агентов с предсказуемым поведением.
</p>

<p align="center">
  <a href="https://github.com/remcod-ru/remcod-agent-runtime/actions/workflows/ci.yml"><img src="https://github.com/remcod-ru/remcod-agent-runtime/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-95FF00" alt="Лицензия Apache-2.0"></a>
  <img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white" alt="TypeScript 7">
</p>

<p align="center">
  Русский · <a href="README.en.md">English</a>
</p>

REMCOD Agent Runtime объединяет типизированные контракты агентов, моделей и
инструментов, ограниченный цикл выполнения, событийный протокол и
детерминированные тесты. Ядро не привязано к конкретной модели или облачной
платформе: провайдеры, хранилища и продуктовые интеграции подключаются через
явные интерфейсы.

> [!IMPORTANT]
> Сейчас реализована локальная in-memory основа **Phase 0 + Phase 1**. Это
> рабочее ядро для разработки и тестирования, но ещё не production-релиз:
> долговременное хранение, policy engine, browser/computer control, scheduler и
> multi-agent orchestration находятся в дорожной карте.

## Быстрый старт

Понадобятся Node.js `24.15.0` и pnpm `11.24.0` через Corepack.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @remcod/example-basic-agent build
pnpm --filter @remcod/example-basic-agent start
```

Пример запускает агента с детерминированной моделью, вызывает типизированный
инструмент `add` и печатает:

```text
{"answer":42}
```

Полная локальная проверка:

```sh
pnpm check
pnpm legal:licenses
```

`pnpm check` проверяет форматирование, линтинг, типы, тесты, покрытие, сборку и
публичные экспорты. Для текущей фазы не нужны API-ключи, сеть, база данных или
Docker. Подробности — в [руководстве для разработчика](docs/guides/contributor-quickstart.md).

## Зачем отдельный runtime

- **Независимость от провайдера.** Модели выбираются через единый контракт без
  зависимости ядра от SDK конкретного поставщика.
- **Безопасные границы.** Лимиты исполнения заданы явно, а операции уровня
  `write` и `privileged` без policy-слоя завершаются по принципу fail closed.
- **Воспроизводимые тесты.** `ScriptedModel` позволяет проверять цикл агента без
  сети и нестабильных внешних ответов.
- **Наблюдаемое выполнение.** Состояние строится из валидированных событий,
  доступных через NDJSON/HTTP transport.
- **Чистое ядро.** Бизнес-правила, полномочия, учётные данные и интеграции
  остаются в отдельных адаптерах.

## Что уже реализовано

```text
protocol → core / tools / model-router → runtime → testing / sdk
                                      └→ NDJSON/HTTP transport
```

| Пакет                       | Назначение в Phase 1                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| `@remcod/protocol`          | Protocol v1, JSON-схемы, идентификаторы, события, ошибки и переходы состояний |
| `@remcod/core`              | Контракты агентов, лимиты выполнения, retry и context compaction              |
| `@remcod/model-router`      | Единый интерфейс моделей и точный выбор провайдера                            |
| `@remcod/tools`             | Типизированные инструменты, валидация, timeout, risk и execution envelope     |
| `@remcod/runtime`           | Ограниченный execution loop, in-memory store, reducer и типизированные ошибки |
| `@remcod/runtime/transport` | Валидированный NDJSON encoder и независимый от фреймворка HTTP handler        |
| `@remcod/testing`           | Детерминированные фикстуры `ScriptedModel`                                    |
| `@remcod/sdk`               | Курируемая публичная поверхность для авторов агентов                          |

Остальные каталоги пакетов и примеров — видимая дорожная карта, а не скрытая
или частично готовая реализация. Workspace-пакеты пока имеют версии `0.0.0`,
остаются приватными и не опубликованы в npm.

## Документация

- [Архитектура и зоны ответственности](docs/architecture/overview.md)
- [Модель выполнения](docs/concepts/runtime-model.md)
- [Публичный API](docs/reference/public-api.md)
- [События и state machine Protocol v1](docs/reference/protocol-v1.md)
- [План реализации Phase 0 + Phase 1](docs/implementation-plan-phase-0-1.md)
- [Дорожная карта Phase 2–10](docs/roadmap.md)
- [Аудит зависимостей, происхождения и лицензий](docs/audits/dependency-provenance-license.md)
- [ADR-0001: граница clean-room реализации](docs/adr/0001-clean-implementation-boundary.md)
- [ADR-0007: идентичность REMCOD Agent Runtime](docs/adr/0007-remcod-agent-runtime-identity.md)

## Участие в разработке

Правила установки, тестирования и подготовки изменений описаны в
[CONTRIBUTING.md](CONTRIBUTING.md). Сохраняйте ядро независимым от провайдеров,
начинайте изменение поведения с теста на публичном интерфейсе и обновляйте
документацию вместе с кодом.

## Лицензия

[Apache-2.0](LICENSE). Автоматические проверки — это защитный контур, а не
юридическое заключение. Перед публикацией пакетов или production-релизом
потребуется отдельная проверка лицензий, NOTICE, происхождения кода и бренда.

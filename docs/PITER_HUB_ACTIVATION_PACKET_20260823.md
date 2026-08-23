# Piter/HUB activation packet — 2026-08-23

## Статус и граница

Пакет подготовлен, но не применён. Он не создаёт policy version, provider
mapping или SubscriptionInstance, не публикует policy, не меняет feature flags,
Node-RED, Viva, MongoDB, продажи, бронирования или оплаты.

Машиночитаемый источник:

`architecture-workspace/evidence/subscriptions/PITER_HUB_ACTIVATION_PACKET_20260823.json`.

Единственная исполняемая команда пакета — локальная read-only проверка:

```bash
npm run subscriptions:piter-hub:activation-packet:check
```

У checker нет `--apply` или сетевого режима. Все будущие production mutation
команды в JSON намеренно равны `null` и требуют отдельного этапа.

## Закреплённое production-состояние

- LK base: `af798452c118406e4fbe545ca3914575346e482f`.
- Public LK release: `430e39a9122db7f6833a6a5ae4132fdc9f43e4ae`, clean.
- CUP release: `d5831753925e114129d8a8246ef1a4734161a1f5`.
- Node-RED active flow SHA-256:
  `0cd277f345e03ccb42e2dd2ba236cbfe5d72f59cf80a39e6815be7344007dfeb`.
- Пять managed-subscription function-body активного flow совпадают с текущим
  `origin/main`; POST `/lk/subscription-bookings` по-прежнему имеет 7-output
  managed-policy graph.
- В ЦУП есть DRAFT v1 Питера и ХАБа, но `providerMappings=0`,
  `policyPublications=0`, `subscriptionInstances=0`, usage ledger пуст.
- Runtime, publication preview/command, activation и deadline worker выключены.

## Какой policy разрешено готовить

Оба типа должны получить новый DRAFT v2 из закреплённого CUP source
`src/subscriptions/annual-subscription-policy-v2-candidate.ts`:

- один общий лимит `CREATE_GAME` или `JOIN_GAME` в день;
- создание только 60 минут;
- присоединение 60, 90 или 120 минут;
- одна единица списания для каждой поддержанной длительности;
- активация по первой подтверждённой provider-записи, иначе
  `2026-10-01T00:00:00+03:00`;
- срок 365 дней от фактической активации;
- Питер — точная одна станция;
- ХАБ — точный 25-ID snapshot, а не `ALL_STATIONS`;
- group training, tournament и create 90/120 add-on остаются недоступны, пока
  для них нет отдельно утверждённых benefit rules.

Read-only проверка закреплённого CUP-кандидата:

```bash
cd /opt/ph-admin-releases/p31-d583175-20260822T130159MSK
npm run subscriptions:annual-v2:check
```

Ожидаются `PITER v1 -> v2`, `HUB v1 -> v2`, соответственно 1 и 25 станций,
`mutationPerformed=false` и два publication blocker:

- `CANONICAL_DICTIONARY_EVIDENCE_ARTIFACT_REQUIRED`;
- `REAL_CANONICAL_TARGET_PRODUCER_REQUIRED`.

Публичный Viva station catalog на 2026-08-23 содержит ровно 25 станций. Его
sorted ID SHA-256 совпадает с HUB CUP candidate:
`cc774da8899ecb71f4c0514f84240719588c51ed5049c84d716dd4ae79acf0f1`.
Direction `4588` подтверждён, но отдельное evidence соответствия type `1613`
не получено. Поэтому `dictionaryEvidenceRef` остаётся `null`, а publication
preview пока запрещён.

## Почему нельзя публиковать текущий v1

HUB v1 содержит `ALL_STATIONS`. LK принимает только exact 25-station set и
заблокирует такой runtime contract как неподдерживаемый. Публикация v1 также
навсегда сделает его первой immutable policy этого типа.

Production CUP сейчас поддерживает только первую публикацию DRAFT-типа:
после неё type перестаёт быть `DRAFT`, а создание следующей версии запрещается.
Значит до публикации v2 необходимо реализовать и проверить supersession:
создание новой DRAFT-версии у опубликованного типа, impact preview, атомарный
переход `PUBLISHED -> SUPERSEDED` и явный выбор `NEW_ONLY` или миграции
существующих instances. Без этого менять правила после запуска невозможно.

## Недостающий instance-import

В production CUP есть repository method `insertRuntimeInstance`, но нет
поддерживаемого admin/API/CLI command, который создаёт реальный instance из
Viva read-back. Существующие synthetic tools нельзя использовать для клиентов,
а ручная запись в Mongo запрещена.

Перед включением runtime нужен отдельный implementation slice:

1. Принимать только точный provider client subscription read-back.
2. Требовать `VERIFIED` mapping и текущую `PUBLISHED` policy.
3. Создавать instance идемпотентно по tenant + provider client +
   `clientSubscriptionId`.
4. Для новой годовой подписки создавать `PENDING_ACTIVATION` с lifecycle из
   immutable policy и актуальным reconciliation evidence.
5. Не разрешать импорт уже активного Piter instance как pending. Для него нужен
   отдельный выбор: provider reset/reissue либо grandfathered ACTIVE с реальными
   датами.
6. Писать durable admin audit, operation, ledger и outbox атомарно.
7. Иметь `--check`/preview, idempotency replay, CAS и negative tests; production
   apply должен оставаться отдельной командой и отдельным подтверждением.

## Порядок будущих gates

1. Реализовать policy supersession/versioning в ЦУП и покрыть тестами.
2. Создать только DRAFT v2 Питера и ХАБа из exact pinned candidate.
3. Получить canonical dictionary/type evidence и доказать реальный canonical
   target producer.
4. Отдельно включить только preview flags и выполнить provider/publication
   preview под глобальной permission.
5. Сохранить возвращённые preview `policyDigest` и `impactPreviewRef`; повторить
   preview непосредственно перед публикацией.
6. После отдельного подтверждения кратковременно включить publication command и
   опубликовать v2. Команда атомарно создаёт `VERIFIED` provider mapping и
   `PUBLISHED` policy.
7. Реализовать и выпустить real instance-import command.
8. Импортировать/reconcile instances по свежему Viva read-back.
9. Provision отдельные server-only runtime/activation tokens и включить только
   runtime-context.
10. Выполнить отдельно разрешённый first-use canary без повторного Viva POST при
    потерянном ответе.
11. Только после canary включить activation, а fixed-date worker — последним
    отдельным gate.

Approval одного пункта не разрешает следующий. До пунктов 1–8 LK1 и LK2 должны
оставаться fail closed.

## Как менять правила после запуска

Целевой процесс после реализации supersession:

1. Создать новую DRAFT policy version, не изменяя опубликованный snapshot.
2. Выполнить provider mapping preview и impact preview.
3. Явно выбрать применение только к новым instances или отдельную миграцию.
4. Опубликовать новую версию атомарно, пометив старую `SUPERSEDED`.
5. Оставить старые operations/ledger привязанными к исходным policy version и
   digest.

До реализации этого процесса первая публикация Питера/ХАБа остаётся
заблокированной.

## Rollback boundary

- Preview/check не меняют состояние и rollback не требуют.
- Включённые preview/runtime flags откатываются возвратом в `false` и
  read-only postcheck; secret values никогда не попадают в packet или Git.
- До первой publication command нужен проверенный backup и поддерживаемая
  операция disable/supersede. Удаление publication/mapping напрямую из Mongo
  не является rollback.
- Instance import и activation требуют собственных compensation/reconciliation
  сценариев до production enablement.

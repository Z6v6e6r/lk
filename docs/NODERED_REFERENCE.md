# 🔴 Node-RED Потоки — Справочник

## Partner game membership API (deployable pilot v0.2, default-off)

- Отдельный M2M namespace: `POST /lk/integrations/v1/open-games/:gameId/members`,
  `DELETE /lk/integrations/v1/open-games/:gameId/members/:membershipId`,
  `GET /lk/integrations/v1/operations/:operationId`.
- Custom node package: `node-red/custom-nodes/partner-game-membership-api/`; request HMAC,
  one-time nonce, idempotency, scopes/station allowlist, canonical ownership и audit
  выполняются внутри server-only runtime.
- Private packet builder: `scripts/prepare_partner_game_membership_v02_packet.mjs`;
  требует fresh verified live workspace и clean exact commit, pins additions-only flow
  contract и custom-node package hashes, пишет только новый внешний `0700/0600` packet.
- Real Viva provider pins Admin API v1 create/read/cancel calls, performs no mutation
  retry and is fail-closed before operation until mutation/revision/idempotency/ON_PLACE
  gates and server token are all ready. Synthetic provider remains loopback test-only.
- Disposable replica rehearsal: `scripts/rehearse_partner_game_membership_mongo.mjs`;
  accepts only loopback, replica discovery, exact `lk_partner_rehearsal_*` DB and ack.
- Полный контракт, threat model, test plan и вопросы внешней команде:
  `docs/PARTNER_GAME_MEMBERSHIP_API.md`.
- Route import, package install/restart, Mongo production prerequisites, secrets,
  ingress/mTLS, external Viva contract approval, deploy и activation остаются
  отдельными R3/R4 gates.

## Legacy game command prerequisites

- Source-only candidate builder: `scripts/patch_live_games_command_prerequisites.mjs`; it is pinned to the exact fresh live-flow SHA and adds no HTTP endpoint.
- Every registered `lk_games` writer must pass the source-fingerprint and graph-relation audit in `scripts/audit_legacy_game_revision_writers.mjs`.
- The active live `fn_patch` fingerprint is verified from the frozen flow node, while the combined candidate fingerprint is verified from `scripts/nodered_games_nodes/fn_patch.js`; these identities must never be collapsed into one registry hash.
- Result lifecycle replay recovers a missing saved game projection only when the current game revision still equals the durable outbox `sourceGameRevision`, then uses that exact revision for the fenced CAS before side effects are released.
- Viva provider execution is released only after an exact primary/majority read-back of provider row id, tenant, result id, and result revision.
- The source-only production migration wrapper audits a fresh database state digest, target fingerprint, exact release/live/candidate/package/runner/verifier/manifest hashes, a custodian-owned read-only release attestation, strict canonical backup/restore/quiescence/runtime evidence files, a domain-separated detached Ed25519 approval, and a one-time execution nonce with ambiguous-ACK recovery. The verifier exists, but production apply remains fail-closed while the source manifest is `UNBOUND`; see `docs/LEGACY_GAME_COMMAND_PRODUCTION_MIGRATION_RUNNER.md` and `docs/LEGACY_GAME_COMMAND_PRODUCTION_TRUST_ANCHOR.md`.
- The production release builder packages the exact runner/custom-node sources and complete installed MongoDB runtime closure. The guarded installer has a read-only `plan` mode and can only create a new commit-addressed custodian-owned release; it never updates a `current` symlink or restarts Node-RED. See `docs/LEGACY_GAME_COMMAND_PRODUCTION_RELEASE_INSTALL.md`.
- Runtime installation, migrations, mapping imports, flow import, provider calls, and gateway activation remain separate guarded R4 tasks.
- The subscription-only and legacy-prerequisite full-flow candidates are source-only and are not sequentially deployable. `scripts/prepare_lk1_subscription_enforcement_candidate.mjs` now builds the single unified source-only graph, but its production custody is `UNBOUND`; import/deploy remains forbidden until a separately approved R4 custody and rollout gate.

## Split booking lifecycle v2

- Initial candidate builder: `scripts/patch_live_split_lifecycle_v2.mjs`.
- Activation-cutoff hotfix builder: `scripts/patch_live_split_lifecycle_v2_cutoff_hotfix.mjs`; pinned to its exact live preimage and limited to the cleanup query and prepare function bodies.
- Creation router: `scripts/nodered_games_nodes/fn_split_router.js` performs booking read-back and owned-empty-exercise compensation.
- Cleanup query, prepare, router, response: `fn_split_cleanup_query.js`, `fn_split_cleanup_prepare.js`, `fn_split_cleanup_router.js`, `fn_split_cleanup_response.js`.
- Scheduler: inject `lk_split_cleanup_scheduler_20260822`, every 120 seconds, five-minute overlap lease.
- Runtime mode: `SPLIT_LIFECYCLE_V2_MODE=OFF|SHADOW|ENFORCE_NEW`; default `SHADOW`.
- Autonomous cohort cutoff: `SPLIT_LIFECYCLE_V2_ENFORCE_FROM=<RFC3339 timestamp with timezone>`; required in `SHADOW` and `ENFORCE_NEW`, otherwise the scheduler skips before lease and Mongo.
- Full contract and acceptance tests: `docs/SPLIT_LIFECYCLE_V2.md`.

## Split payment draft confirmation

- `POST /lk/games/drafts` is the only browser write before Viva redirect. The draft remains `PAYMENT_PENDING`; aliases and generic `POST /lk/games` are not payment-confirmation fallbacks.
- `POST /lk/games/payment/confirm` accepts `paymentRef` as lookup identity, loads the unique durable draft, and verifies the exact Viva transaction with server credentials. The client cannot supply authoritative paid status, amount, currency, transaction, booking, exercise, or player identity.
- Confirmation succeeds only for Viva `PAID` and exact transaction, booking, exercise, amount, currency, and available client identity matches. Pending, cancelled, failed, missing, mismatched, or duplicate evidence fails closed and does not publish a paid game.
- Before either callback or cleanup can publish, the verified Viva transaction is atomically claimed in `lk_game_payment_evidence_claims` under `_id=viva_transaction:<transactionId>` using only `$setOnInsert`, then read back and matched to exact game, `paymentRef`, transaction, and booking. A concurrent or replayed claim owned by another game fails closed.
- Source functions: `fn_game_payment_confirm_lookup.js`, `fn_game_payment_confirm_router.js`, `fn_game_confirm_write_ack.js`, `fn_game_upsert_args.js`, and the internal proof guard in `fn_create.js`.
- Confirm writes are fenced by the draft revision/`updatedAt`, use `upsert:false`, and do not emit a success response or autojoin before `acknowledged=true`, `matchedCount=1`, and an exact `PAID` Mongo read-back. Cleanup writes use the same stale-snapshot fence and emit `cancelledInLk=true` only after an acknowledged one-row update and exact status/paid/`updatedAt` read-back through `fn_split_cleanup_write_ack.js`.
- The existing 120-second split cleanup scheduler reconciles users who never return from Viva. A verified and atomically claimed late organizer payment promotes the durable game to `PAID`; unverified entries remain non-public.
- Guarded candidate builder: `npm run nodered:game-payment-confirmation:patch -- --input <fresh-live-flow> --output <candidate> --report <report>`. It is pinned to an exact live preimage, preserves the route set, and never imports or deploys the candidate.

## Что это и зачем

Node-RED — визуальный инструмент автоматизации. В этом проекте он выступает бэкенд-слоем между фронтендом (личный кабинет) и базой данных (MongoDB). Потоки обрабатывают HTTP-запросы от фронта и MAX-бота.

---

## Модульный workflow (обязательный)

Текущий рабочий процесс зафиксирован в отдельном регламенте:

- `docs/NODERED_MODULAR_WORKFLOW.md`

Коротко:

1. Источник: `node-red/modular/source.flow.json`
2. Метаданные pulled source: `node-red/modular/source.flow.meta.json`
3. Канон: `node-red/modular/lk.flow.modular.json`
4. Блочные импорты: `node-red/modular/imports/*.import.json` и `*.nodes.import.json`
5. Проверка целостности: `node-red/modular/validation.json`

Команда пересборки:

```bash
npm run nodered:modular:build
```

---

## Файлы для импорта

> Импортировать через Node-RED UI: Меню → Import → вставить содержимое файла

### Актуальные объединённые потоки (накопительные версии)

| Файл | Что включает |
|------|-------------|
| `ЛК03_03_26.with_games.json` | Базовый поток + игры |
| `ЛК03_03_26.with_games_chat.json` | + чат в играх |
| `ЛК03_03_26.with_games_chat_results.json` | + результаты матчей |
| `ЛК03_03_26.with_games_chat_results_communities.json` | + сообщества |
| `ЛК03_03_26.with_games_chat_results_communities_support.json` | + поддержка + MAX (полный) |

**Рекомендуется:** импортировать последний файл из списка — он включает всё.

### Отдельные модульные потоки (для точечных обновлений)

| Файл | Назначение |
|------|-----------|
| `node-red/modular/imports/lk_games.import.json` | Рекомендуемый tab+nodes import для LK Games, включая result lifecycle |
| `node-red/modular/imports/lk_games.nodes.import.json` | Рекомендуемый nodes-only import для точечного обновления LK Games на `147` |
| `lk_games_nodes_import.json` | Legacy import игровых нод |
| `lk_game_chat_nodes_import.json` | Legacy import чата игр |
| `lk_game_results_nodes_import.json` | Legacy import result-контура; не использовать вместо modular `lk_games*.import.json` |
| `lk_communities_nodes_import.json` | Legacy import сообществ |
| `lk_support_dialog_nodes_import.json` | Legacy import поддержки |
| `lk_max_webhook_nodes_import.json` | Legacy import MAX-бота + роутера |
| `поток-lk.mongodb4.json` | MongoDB трансформации |

### Исторические fix-файлы (архив, не импортировать повторно)
`node-red.communities.fix-*.json`, `node-red.games.live-ratings-*.json`, `node-red.results.grade-threshold-fix-*.json`, `node-red.communities.admin-tools-*.json`

---

## Структура функций по модулям

### 📁 `scripts/nodered_games_nodes/`
| Файл | Назначение |
|------|-----------|
| `fn_list_query.js` | Формирование запроса списка игр |
| `fn_list_normalize.js` | Нормализация ответа со списком |
| `fn_get_by_id_query.js` | Запрос игры по ID |
| `fn_get_by_id_resp.js` | Ответ на запрос игры |
| `fn_create.js` | Создание новой игры |
| `fn_patch.js` | Изменение игры (join/leave/update) |
| `fn_live_ratings_*.js` | 6 файлов для live-рейтингов (авторизация, запрос, парсинг, кэш) |

### 📁 `scripts/nodered_chat_nodes/`
| Файл | Назначение |
|------|-----------|
| `fn_chat_get_*.js` | Получение сообщений чата |
| `fn_chat_post_*.js` | Отправка нового сообщения |
| `fn_chat_read_*.js` | Отметка сообщений прочитанными |
| `fn_chat_list_*.js` | Список чатов |

### 📁 `scripts/nodered_max_nodes/`
| Файл | Назначение |
|------|-----------|
| `fn_max_webhook_prepare.js` | Обработка входящего MAX-webhook |
| `fn_max_support_route.js` | Маршрутизация по состоянию клиента |
| `fn_max_client_lookup_prepare.js` | Поиск клиента по телефону/MAX-ID |
| `fn_max_outbox_pull_*.js` | Извлечение очереди исходящих ответов |
| `fn_max_outbox_dispatch_prepare.js` | Подготовка отправки в MAX |
| `fn_max_outbox_ack_prepare.js` | Подтверждение доставки |

---

## API эндпоинты (SERV2 / support)

### Игры
- `GET /api/games` — список игр
- `GET /api/games/:id` — игра по ID
- `POST /api/games` — создать игру
- `PATCH /api/games/:id` — обновить (join/leave)
- `GET /api/games/:id/ratings` — live-рейтинги
- `POST /api/games/:id/result` — записать результат

### Рейтинг сообщества

- `GET /lk/communities/:communityId/rating` — полный подготовленный рейтинг сообщества.
- `GET /lk/communities/:communityId/players/:playerId/rating` — минимальный рейтинг одного текущего участника по точным ID сообщества и игрока; public alias без `/lk` имеет тот же контракт.
- Endpoint одного игрока читает только `community_rating_snapshots`, не сопоставляет телефон/имя и не возвращает имя, телефон или аватар. Отсутствующий/stale snapshot завершается fail-closed `503`.
- Source functions: `scripts/nodered_community_player_rating_nodes/`; guarded patch: `scripts/patch_nodered_community_player_rating_flow.mjs`.

### Сообщества публикации турнира

- `GET /lk/tournaments/americano/history?tournamentId=<id>` возвращает `publishedCommunities`, `ratingCommunityId` и `ratingCommunityStatus` из активных точных публикаций `lk_community_feed`.
- Команда `POST /lk/tournaments/broadcast/start` передаёт приставке `community_id`, `rating_community_id` и `published_communities`, если публикации существуют; без публикаций сохраняется старый request body.
- Несколько публикаций без единственного `RATING_PRIMARY` дают `ratingCommunityId=null` и статус `AMBIGUOUS`.
- Source functions: `scripts/nodered_tournament_community_nodes/`; guarded source-first patch: `scripts/patch_live_tournament_community_context.mjs`.

### Атомарная запись по абонементу

- `POST /lk/subscription-bookings` — единая серверная точка дневного claim. Для `action=book` обязательны Bearer, стабильный non-secret `operationId`, `exerciseId` и точный `clientSubscriptionId`; для `action=release` — Bearer, отдельный стабильный `operationId` и точный `bookingId` подтверждённо отменённой записи.
- `OPTIONS /lk/subscription-bookings` — CORS preflight для `Authorization` и `Content-Type`. Browser-клиенты передают `operationId` query-параметром, потому что текущий nginx CORS allowlist не пропускает отдельный idempotency header.
- Split create/join сохраняют прежние публичные маршруты `/lk/games/split/create` и `/lk/games/:gameId/split/join`, но subscription-ветка внутри `Route Viva split payment` уходит в тот же атомарный контур.
- Split create всегда получает pricing policy из CUP по точным дате/станции/корту до provider mutation, включая оплату организатора абонементом. Для subscription-created игры join повторяет exact CUP lookup вместо доверия сохранённой/browser-сумме; legacy запись без snapshot получает промо только при совпадении её сохранённых location/date с текущим выбранным CUP campaign.
- Если legacy split-запись потеряла и `selectedPaymentMode`, и snapshot тарифа, zero-amount организатора сам по себе не даёт промо. Join сначала подтверждает exact organizer booking у Viva: тот же exercise, `paymentType=SUBSCRIPTION`, точный `clientSubscriptionId`, `isCancelled=false` и `cancelled=false`; только затем перечитывает CUP campaign. Неоднозначность или provider outage завершаются fail-closed до создания новой транзакции.
- Точечно восстановленная one-time игра без snapshot тарифа входит в recovery только с exact маркером `missing_lk_record_after_successful_split_create/direct_guarded_mongo_upsert`, совпадающими paid-amount в game/organizer payment, одним organizer booking и точным organizer client. Затем server read-only подтверждает у Viva активный `ON_PLACE` booking и ровно одну `PAID` transaction с теми же booking/client/date/amount; только после этого перечитывается текущая exact CUP policy. Любое отсутствие или несовпадение evidence блокирует join до новой provider mutation.
- One-time split требует пользовательский Bearer и server-side проверку точного тарифа до Viva mutation: Admin API подтверждает `stationId/roomId`, End User API подтверждает допустимые `masterServiceId/subServiceIds` для станции и возвращает цену по точным `station + room + date/time`. Обычная доля равна этой цене, делённой на серверный `shareCount`; `available product cost`, browser `totalAmount` и browser `shareAmount` не являются pricing authority.
- Payment URL для one-time split возвращается только при явном совпадении Viva `toPay/toPayMinor` с canonical `shareAmountMinor`. Если create-response содержит URL и transaction ID, но не сумму, router сначала делает read-back exact transaction; несовпадение или отсутствие суммы даёт `409 SPLIT_PROVIDER_AMOUNT_MISMATCH` без выдачи URL.
- Split create/join и cleanup получают form-urlencoded token request body только из env `VIVACRM_TOKEN_REQUEST_BODY` либо из защищённого Node-RED global context `vivacrm_token_request_body`. Inline fallback отсутствует: при пропущенной конфигурации новые операции отвечают `503 VIVA_TOKEN_CONFIG_MISSING`, а cleanup фиксирует fail-closed provider error. Значение нельзя хранить в flow/source/export или выводить в логи; действующие credentials после удаления legacy-литералов подлежат отдельной ротации до deploy.
- Canonical payment confirmation для one-time требует точный Viva status `PAID` и совпадение transaction, booking, exercise и телефона игрока. Subscription confirmation требует точные booking/exercise/client, `paymentType=SUBSCRIPTION` и явные `isCancelled=false`, `cancelled=false`; отсутствие этих boolean-полей не считается успехом.
- Subscription-режим split create/join обязан передавать точный `clientSubscriptionId`, выбранный пользователем. При отсутствии id prepare-ноды отвечают `400 SUBSCRIPTION_SELECTION_REQUIRED`; если доступный Viva product не совпадает с выбранным id, router отвечает `409` и не переключается на другой абонемент или one-time оплату.
- Split payment statuses `LEFT`, `REMOVED_*` и `RELEASED` не удерживают место, не дают active-membership и не блокируют повторное присоединение. Успешный split leave в одном Mongo CAS переводит точную payment generation в `LEFT`, удаляет активные roster/waitlist aliases и делает `$unset` устаревшего `resultRosterSnapshot`; следующий result-session строит snapshot заново из актуального состава.
- `clientId`, телефон, дата, категория и название абонемента из тела запроса не являются доверенными. Сервер получает actor через `GET /end-user/api/v1/iSkq6G/profile`, упражнение — через Viva по `exerciseId`, а выбранный `clientSubscriptionId` обязан присутствовать в `availableClientSubscriptions` этого упражнения. При необходимости название плана разрешается через server-side SERV2 lookup по проверенному телефону.
- Проверка лимита fail-closed объединяет активные записи и history. Поддерживаются nested End User payload и flat Admin payload, включая `exerciseDate`, `exerciseDirection` и `exerciseType`. Отмена/refund освобождают дату; разные точные `clientSubscriptionId` независимы. Release не доверяет присланным exercise/subscription/date: он извлекает их из exact cancelled `bookingId` в actor-scoped Viva history и отказывает, пока запись остаётся активной.
- Атомарный ключ Mongo для общего лимита с `2026-08-01`: `_id = tenantKey + clientSubscriptionId + YYYY-MM-DD`, коллекция `lk_subscription_daily_booking_ops`. До этой даты ключ дополнительно содержит категорию, сохраняя прежний отдельный лимит; для абонементов вне дневной политики (например, `Энергия 5`) claim ограничен конкретным `exerciseId`. Состояния: `PREPARED -> PENDING_CONFIRMATION -> CONFIRMED|FAILED|RELEASED`; создание игры использует дополнительные `PRECREATE_RESERVED -> PRECREATE_ATTEMPTING`, а после принятого CREATE неполная повторная проверка закрепляется как `PRECREATE_RECONCILIATION_REQUIRED` — entitlement и созданная игра не освобождаются ни по TTL, ни при competing retry. До CREATE операция сохраняет точный recovery target (`actor/subscription/policy/station/room/category/type/start/duration/date`). Если CREATE был принят, но его id не закрепился в Mongo, только повтор того же `operationId` выполняет actor-scoped read-only lookup; ровно одно полное совпадение связывается с entitlement через CAS и продолжает booking без второго CREATE, а ноль, несколько или неполные совпадения остаются `202` без release/DELETE/provider write. Mongo ACK принимается только как точный плоский ответ драйвера без upsert. До upstream POST операция обязательно сохраняется как `PENDING_CONFIRMATION`; release точной отменённой записи переводит также delayed `PENDING_CONFIRMATION` в `RELEASED` и сохраняет `releasedBookingIds` для идемпотентности повторов.
- Дневной claim считается по событию: split на 90/120 минут сохраняет прежний серверный `count=2` для фактического списания Viva, но занимает один ключ даты и не разрешает второе событие в тот же день.
- Tournament/group вызывают Viva Admin v2 с точным `clientSubscriptionId` и `customFields: []`; split сохраняет проверенный Admin v1 + server-derived `count` контракт. Service token берётся только из Node-RED context `vivacrm_access_token`. В flow/import/frontend не добавляются credentials.
- Transport timeout, 5xx или неполный readback не освобождают claim: наружу возвращается `202 PENDING_CONFIRMATION`. Повтор с тем же `operationId` сначала перечитывает Viva; другой operation не может выполнить второе списание.
- Frontend-проверка active+history оставлена только как быстрый UX precheck. Источником соблюдения правила является серверный claim, а не браузер.
- Source functions: `scripts/nodered_subscription_booking_nodes/`; guarded patch: `scripts/patch_nodered_subscription_booking_flow.mjs`; split dispatch source: `scripts/nodered_games_nodes/fn_split_router.js`.
- `fn_managed_subscription_policy_evaluate.js` — двухвыходный evaluator опубликованной managed-policy, подключённый к source-driven `/lk/subscription-bookings` candidate. Он принимает только server-resolved target, exact policy/instance version и authoritative usage snapshot; output 1 означает eligibility, output 2 — fail-closed blocker. После атомарного preaccept gateway повторно читает exact Viva exercise/ownership, затем для managed-планов повторно читает CUP runtime context и запускает evaluator непосредственно перед Viva booking POST.
- Generic `PATCH /lk/games/:gameId` и `/lk/games/records/:gameId` безусловно отклоняют browser-owned `participants`/`waitlist` с `GAME_ROSTER_COMMAND_REQUIRED`; roster изменяется только через canonical command/split boundaries.
- Managed annual status остаётся read-only, а purchase fail closed с `MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE`, пока нет authoritative sale-to-current-instance binding. Legacy builder `prepare_tournament_subscription_sales_candidate.mjs` безусловно quarantined после добавления Piter atomic topology и не создаёт артефакт; снять quarantine можно только через отдельный exact candidate binding и review. Обнаруженный live-дубликат `Media2` сейчас disabled и не является активным route.
- С 2026-09-03 `friendship` и `ra` используют новые независимые inventory
  `ab_leto_2026_150_v2_<counterKey>` с launch pool 150; старые продажи не входят в
  новые остатки. `network_friendship` сохраняет inventory `network_friendship_12m_2026_v1`
  и общий остаток, но status ограничивает видимое окно 10 продажами за календарный
  день `Europe/Moscow`; managed annual purchase остаётся fail closed. Новая схема
  включается только при exact boolean global flag
  `summer_subscription_ab_leto_20260903_release_enabled=true`; без него runtime
  сохраняет предыдущие inventory и лимиты.
- Реферальная атрибуция и шесть credential source-файлов выпускаются только двухфазным `nodered:referral-attribution:audit` → reviewed contract SHA → `nodered:referral-attribution:candidate`. Candidate меняет девять exact live function instances, оставляет `deployAuthorized=false` и блокирует provider rotation, пока inventory показывает другие active password-grant consumers.
- Контракт evaluator и обязательный порядок будущего подключения описаны в `docs/MANAGED_SUBSCRIPTION_RUNTIME_CONTRACT.md`. Для явно managed Viva product отсутствие опубликованной policy в будущем должно блокировать действие, а не откатываться к hardcoded plan-name логике.
- PITER managed enforcement дополнительно требует server-owned `purchaseDate` выбранного `availableClientSubscriptions` не раньше `2026-09-01` в `Europe/Moscow`. Валидная более старая дата остаётся в Friendship compatibility path; для allowlisted exact PITER missing, invalid или conflicting дата завершается `409 SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED`, а на recheck переводит операцию в `operation_fail` до Viva write. Browser date не участвует, а дата и cutoff eligibility повторно проверяются перед Viva write.
- Focused candidate для явного выбора split-абонемента строится только из закреплённого свежего live-147 snapshot через `scripts/patch_live_split_subscription_selection.mjs`. Он меняет только function bodies `Prepare split game payment`, `Prepare split join payment` и `Route Viva split payment`, сохраняет граф/маршруты и не деплоит candidate.
- Focused candidate для invalidation stale roster snapshot после split leave строится через `scripts/patch_live_split_leave_projection_consistency.mjs`. Он меняет только `Build split leave game CAS`, сохраняет граф/маршруты и не деплоит candidate.
- Патчер принимает только отдельный свежий live-147 snapshot с корректным `source.flow.meta.json`, проверяет origin/SHA/свежесть до 30 минут и один из двух точных preimage функции `Route Viva split payment`: исходный до gateway либо уже управляемый gateway. Он пишет новый candidate, но не изменяет source snapshot и не деплоит его.

### Чат
- `GET /api/game-chat/:gameId` — список чатов
- `GET /api/game-chat/:gameId/messages` — сообщения
- `POST /api/game-chat/:gameId/messages` — отправить
- `POST /api/game-chat/:gameId/read` — отметить прочитанными

### Поддержка (Support)
- `GET /api/support/clients/resolve` — найти клиента
- `GET /api/support/connectors` — список коннекторов
- `GET /api/support/connectors/:connector/stations/:stationId/dialogs` — диалоги станции
- `GET /api/support/dialogs/:id/messages` — история диалога
- `POST /api/support/dialogs/events` — записать событие (входящее/исходящее)
- `POST /api/support/dialogs/:id/reply` — ответ администратора
- `GET /api/support/analytics/daily` — дневная аналитика
- `GET /api/support/outbox/pull?connector=MAX_BOT` — очередь для MAX

### Push (FCM)
- `POST /lk/push/register` — зарегистрировать/обновить device token
- `POST /lk/push/unregister` — деактивировать token при logout
- `POST /lk/push/admin/send` — отправить push из ЦУП по токену/фильтрам

### Журнал согласий авторизации

- `POST /lk/analytics/auth-consents` — идемпотентно зафиксировать принятие текущего набора документов после авторизации.
- `OPTIONS /lk/analytics/auth-consents` — CORS preflight.
- Bearer-токен проверяется через Keycloak `clients/userinfo`; `subject`, телефон и client ID из тела запроса не принимаются.
- Коллекция: `lk_auth_consents`; immutable `_id = tenant + lossless encoded verified subject + documentSetVersion`.
- Текущая внутренняя версия набора документов: `2026-07-14`.
- До записи проверяются `sub`, client `widget` и tenant `iSkq6G`: bearer проходит `clients/userinfo`, а client/tenant берутся только из проверенного token context/userinfo, не из request body.
- Frontend связывает staged-запись с hash конкретного OAuth `state` или SMS-телефона, после первого неуспешного POST повторяет доставку с bounded backoff, а также на `online` и возврате вкладки.
- Source functions: `scripts/nodered_auth_consent_nodes/`; patch: `scripts/patch_nodered_auth_consents_flow.mjs`.
- Focused import генерируется как `node-red/modular/imports/lk_auth_consents.nodes.import.json` только после fresh pull live flow с `147`; default patch path fail-closed проверяет origin metadata, SHA-256 исходного flow и свежесть pull не более 30 минут.

### Трансляция результатов турнира

- `GET /lk/tournaments/broadcast/status?tournamentId=<id>` — запросить фактический status приставок и синхронизировать безопасное состояние трансляции.
- `POST /lk/tournaments/broadcast/start` — запустить трансляцию; body для обычной станции: `{ "tournamentId": "...", "stationId": "..." }`; для Сколково и Нагатинской обязательно добавляется `"target": "right_arena" | "left_arena" | "both"`.
- `POST /lk/tournaments/broadcast/stop` — остановить ранее сохранённые active targets; body: `{ "tournamentId": "...", "stationId": "..." }`, новый выбор target не принимается.
- `OPTIONS /lk/tournaments/broadcast/:action` — CORS preflight для status/start/stop.
- Пользовательский Bearer проверяется через Viva `GET /end-user/api/v1/iSkq6G/profile`. После этого сервер проверяет право `Проводит турниры` либо совпадение с organizer сохранённого турнира.
- `boxId` не принимается от frontend. Он разрешается по каноническому `stationId` из server-side проекции настроек станций ЦУП (`CUP_STATION_SETTINGS_JSON`): legacy-поле `tournamentBroadcastBoxId` для одной приставки или `tournamentBroadcastTargets.right_arena/left_arena` для Сколково и Нагатинской.
- Multi-screen target разрешён только для точных station ID: Сколково `0d5504f6-ea6f-44bb-a9e4-947faf0273ab`, Нагатинская `6b2d7e60-caff-4b22-89f6-6f19d7d311ab`. Имя станции и `stationId` из request body не дают право включить этот режим. Терехово остаётся legacy single-screen станцией.
- Повторный start при сохранённой активной multi-screen трансляции отклоняется: fresh transition возвращает `BROADCAST_OPERATION_IN_PROGRESS`, остальное active state — `BROADCAST_ALREADY_ACTIVE`; перед выбором другого target требуется штатный stop.
- Внешний Bearer хранится только в `TOURNAMENT_BROADCAST_BEARER_TOKEN`; frontend его не получает.
- Внешний API задаётся через `TOURNAMENT_BROADCAST_API_BASE_URL`. Node-RED вызывает `POST /integrations/v1/devices/{box_id}/tournament/start|stop` и `GET /integrations/v1/devices/{box_id}/status`. Status считается активным только при `online=true`, `tournament_active=true` и точном совпадении `tournament_id` с текущим Viva ID.
- Для `both` server-side proxy отправляет две команды, агрегирует ответы и только затем обновляет `tournaments.params.broadcast`. При частичном start выполняется компенсирующий stop уже запущенной приставки; если компенсация или stop частично не удались, сохраняются `status=partial` и только безопасные `activeTargets`, чтобы следующий stop мог завершить очистку.
- Перед multi-screen start выполняется атомарный Mongo claim: `active=true`, `status=starting`, intended `activeTargets` и 60-секундный recovery lease. Device fan-out начинается только после `acknowledged=true`, `matched=1`, `modified=1`; финальная запись использует CAS. Fresh `starting` блокирует start/stop с `409 BROADCAST_OPERATION_IN_PROGRESS`, а после lease stop восстанавливает все intended targets.
- Каждая исходящая device-команда явно несёт runtime-поле `msg.requestTimeout=20000`; конфигурационное поле HTTP Request node оставлено только как дополнительная документация и не считается источником таймаута. Join ограничен 25 секундами. Любой неполный multi-screen start, включая transport timeout, запускает compensating stop для всех intended targets; claim очищается только после подтверждённой компенсации и Mongo CAS.
- HTTP 200 возвращается только после Mongo `updateOne` с явным `acknowledged=true` и положительным matched/modified evidence. Тексты ошибок device API не проксируются в браузер: наружу возвращаются только фиксированные безопасные сообщения.
- Source functions: `scripts/nodered_tournament_broadcast_nodes/`; patch: `scripts/patch_nodered_tournament_broadcast_flow.mjs`; focused import: `node-red/modular/imports/lk_tournament_broadcast.nodes.import.json`.

---

## MAX-бот — схема работы

```
MAX webhook (входящий)
    │
    ▼
fn_max_webhook_prepare.js
    │  msg.maxUpdate = { userId, phone, text, type }
    ▼
fn_max_client_lookup_prepare.js
    │  GET /api/support/clients/resolve?maxId=...
    ▼
fn_max_support_route.js
    │  Состояния: NEW → UNVERIFIED → VERIFIED → STATION_SELECTED
    │  Действия:
    │  ├── /start → отправить кнопку "Поделиться контактом"
    │  ├── contact → нормализация, resolve клиента, переход в VERIFIED
    │  ├── VERIFIED без станции → запросить выбор станции
    │  ├── station_selected → переключить диалог, сохранить историю
    │  └── message → POST /api/support/dialogs/events
    ▼
(каждые 5 секунд)
GET /api/support/outbox/pull?connector=MAX_BOT
    │
    ▼
fn_max_outbox_dispatch_prepare.js → отправить в MAX API
    │
    ▼
fn_max_outbox_ack_prepare.js → подтвердить доставку
```

---

## Патч-скрипты

При обновлении исходников в `scripts/nodered_*_nodes/` нужно пересобрать flow-файлы. Для live-совместимого LK Games/result контура сначала pull с `147`, затем patch, потом build/validate:

```bash
node scripts/patch_nodered_games_flow.mjs
node scripts/patch_nodered_chat_flow.mjs
node scripts/patch_nodered_results_flow.mjs
node scripts/patch_nodered_communities_flow.mjs
node scripts/patch_nodered_support_flow.mjs
node scripts/patch_nodered_max_flow.mjs
```

Скрипт берёт содержимое JS-файлов и вставляет их в соответствующие function-ноды в JSON-потоке.

Для актуального пути релиза `147` см. `docs/NODERED_MODULAR_WORKFLOW.md`: каноничный import для LK Games теперь находится в `node-red/modular/imports/lk_games.import.json` и `lk_games.nodes.import.json`.

Общий server-side `User-Agent` для Viva строится отдельным guarded-патчером
`scripts/patch_live_viva_user_agent.mjs` только из свежего verified live-147
workspace. Он меняет исключительно configured headers HTTP Request-узлов и не
импортирует candidate. Контракт и проверки описаны в `docs/VIVA_USER_AGENT.md`.

## Legacy game command transaction prerequisite

The source-only prerequisite for future LK2-to-legacy commands is documented in
`ADR_LEGACY_GAME_COMMAND_TRANSACTION_PREREQUISITES.md`. It adds no HTTP endpoint.
The config node type `padlhub-legacy-game-command-store` exposes a server-side
transaction service to a future custom node and reads its Mongo URI from server-only
environment injection. Revision writer inventory and migration/runbook details are in
`LEGACY_GAME_COMMAND_MIGRATIONS.md`. Result submission uses a mandatory canonical
idempotency key with a collision-free tenant-qualified durable identity and
primary/majority read-back. Result lifecycle side effects are asynchronous: the durable
transition returns `202`, while rating/event/Viva sinks are driven by the versioned
outbox and exact tenant/result/revision contracts.

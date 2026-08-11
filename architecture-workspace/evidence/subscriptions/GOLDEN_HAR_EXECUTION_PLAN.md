# Golden HAR Execution Plan — Managed Annual Subscriptions

Date: 2026-08-11

Status: `READY_FOR_TEST_DATA_ASSIGNMENT`. Runtime mutations have not started.

First live read-only result: `W0_PREFLIGHT_2026-08-11.md`. W1 remains `NO_GO`
until a synthetic tester, exact provider ids, balance and safe target are assigned.

This document turns the Golden HAR passport into an executable QA and evidence
plan. It does not approve production testing by itself. Every write requires an
exact test record, a cleanup owner, and an explicit mutation window.

## 1. Что проверяем и в каком порядке

Есть два разных класса проверок:

1. **Provider contract discovery** — можно начинать на текущем LK/Viva после
   назначения безопасных тестовых данных. Цель: увидеть фактические Viva
   request/response/readback для booking, cancellation, balance и payment.
2. **Acceptance tests будущей реализации** — выполняются только после появления
   Subscription Core, ЦУП-настроек и общего `/api/v1` контракта. Они проверяют
   партии, policy versions, atomic limits, LTV и одинаковое поведение двух ЛК.

Нельзя считать второй класс пройденным по текущей hardcoded-логике `ab_leto`.

### Волны

| Wave | Содержание | Когда запускать | Результат |
|---|---|---|---|
| `W0` | Read-only discovery и точные test records | Сейчас | Приватный run registry, GO/NO-GO |
| `W1` | `JOIN 60` и отдельная `SERVICE cancellation` | После W0 и approval | Первые два Golden HAR candidate |
| `W2` | Create/join 60/90/120, balance и lifecycle | После review W1 | Provider duration/usage contracts |
| `W3` | Active limit, daily limit, window и policy toggles | После Subscription Core | Server enforcement acceptance |
| `W4` | Group/tournament/game benefits | После benefit rules | Price/routing acceptance + HAR |
| `W5` | Партии, ladder, 100→7/day и покупка | После inventory/purchase implementation | Concurrency/payment evidence |
| `W6` | Whole-game cancel, mixed refunds, unpaid/late-paid | После durable operations | Reconciliation evidence |
| `W7` | LTV, audit и current/new LK parity | После ledger/read models | Product release certification |

## 2. Первый рекомендуемый прогон

Первым выполняется парный прогон, но с **двумя отдельными HAR**:

1. `GHAR-BKG-JOIN-060` — тестер один раз присоединяется по активной подписке к
   заранее подготовленной 60-минутной тестовой игре.
2. `GHAR-CAN-SELF-SERVICE` — после подтверждённого join тот же тестер выходит,
   а посещение возвращается по фактическому provider contract.

Почему этот порядок:

- join не требует одновременно доказывать create exercise и create booking;
- 60 минут — минимальный baseline перед 90/120;
- cancellation является контролируемым cleanup первого действия;
- пара сразу проверяет active/history, roster, balance и hard reload;
- card/deposit payment не нужен.

Первый прогон нельзя делать на реальной игре с клиентами или на единственном
активном посещении подписки без заранее согласованной компенсации.

## 3. Роли

| Роль | Обязанность | Не совмещать с |
|---|---|---|
| Test owner | Выбирает run, окно и принимает GO/NO-GO | Независимым evidence reviewer |
| Viva operator | Готовит tester/subscription/exercise, делает read-only snapshots | Пользовательским кликом join/leave |
| Browser tester | Выполняет ровно одно действие, сохраняет raw HAR | Ручным исправлением provider state |
| LK observer | Фиксирует API/Mongo/roster/publication до и после | Provider mutation |
| Evidence reviewer | Проверяет sanitization и полноту контракта | Автором HAR |
| Cleanup owner | Удаляет только согласованные тестовые остатки после readback | Автоматическим retry без проверки |
| Product/Viva owner | Заранее задаёт ожидаемый balance delta и refund policy | Подменой фактического результата |

Для маленькой команды роли могут выполнять одни люди, но review HAR должен
сделать человек, который не нажимал кнопку.

## 4. Какие данные надо подготовить

Raw ids и PII хранятся только в приватной копии
`GOLDEN_HAR_RUN.example.json` вне Git. В Git и сообщениях используются aliases и
masked suffix.

### Обязательный минимум для W1

| Поле | Требование |
|---|---|
| Environment | Staging/sandbox; production только отдельным exact approval |
| Mutation window | Начало/конец, timezone, ответственный |
| Station | Exact Viva station/studio id, alias, `Europe/Moscow` или фактическая timezone |
| Tester | Отдельный synthetic/test client без чужих активных услуг |
| Subscription | Exact active `clientSubscriptionId`, product id/type, validity, initial balance |
| Expected 60-minute delta | Число посещений, утверждённое Product/Viva owner до теста |
| Target game | Exact LK game id и Viva exercise id, 60 минут, минимум одно место |
| Organizer | Тестовый организатор, не реальный клиент |
| Category/type | Canonical provider ids, не отображаемое название |
| Cleanup | Кто и как удаляет оставшуюся тестовую игру после cancellation proof |
| Runtime fingerprints | LK release SHA, Node-RED/live flow SHA, CUP/API SHA, browser/version |
| Evidence storage | Приватный каталог mode `0700`, файлы mode `0600` |

### Требования к tester

- учётная запись контролируется командой;
- в профиле нет данных реального клиента;
- активная подписка совместима с выбранной станцией и типом игры;
- срок подписки покрывает service date;
- balance достаточен для join и не равен неизвестному/ошибочному значению;
- в выбранный station-local день нет другой расходующей entitlement записи;
- active services до теста однозначно посчитаны;
- нет незавершённой оплаты или reconciliation case;
- tester можно безопасно вернуть в исходное состояние.

### Требования к target game

- 60 минут по provider start/end, не только по тексту карточки;
- станция и type ids входят в entitlement scope;
- дата попадает в текущее разрешённое окно;
- игра создана только для теста и не опубликована реальным клиентам;
- roster до join содержит ожидаемых тестовых участников;
- exact exercise доступен в provider active/inclusive readback;
- нет waitlist, реальных платежей и чужих бронирований;
- после self-leave игра остаётся в предсказуемом состоянии для cleanup.

### Полный набор данных для W0-W7

Минимальный независимый набор, чтобы сценарии не влияли друг на друга:

| Объект | Количество | Назначение |
|---|---:|---|
| Test clients | 8 | CUP operator, 2 buyers, entitlement, benefit, cancellation, organizer, auditor |
| Test stations | 2 | Одна внутри scope, одна контрольная вне scope |
| Annual products | 4+ | Отдельные provider mappings для price phases или доказанный dynamic amount |
| Active subscriptions | 3+ | Duration/limits, benefits и cancellation без общего daily-state |
| Games | 6+ | Create/join по 60/90/120, отдельная mixed-cancel game |
| Group events | 3 | Allowed type, disallowed type, out-of-scope station |
| Tournaments | 2 | Benefit success и cancellation/refund |
| Payment methods | Sandbox set | Subscription, card, deposit; реальные деньги только по Finance approval |

Рекомендуемые aliases:

| Alias | Данные/роль |
|---|---|
| `tester-cup-a` | Station-scoped operator с catalog/release permissions |
| `tester-buyer-a` | Покупка и границы phase |
| `tester-buyer-b` | Гонка за последнюю единицу |
| `tester-entitlement-a` | Create/join/daily/active/window |
| `tester-benefit-a` | Group/tournament price и station/type scope |
| `tester-cancel-a` | Self-leave, attendance/no-show/refund |
| `tester-organizer-a` | Remove participant и whole-game cancellation |
| `tester-auditor-a` | Read-only Buyers/LTV/Audit/Reconciliation |

Один реальный client не может использоваться под несколькими aliases только
для ускорения: его active/history, daily claim и LTV смешают независимые тесты.

## 5. Структура приватного evidence run

Рекомендуемая структура вне репозитория:

```text
<private-evidence-root>/<run-id>/
  run.private.json
  journal.md
  raw/
    GHAR-BKG-JOIN-060.raw.har
    GHAR-CAN-SELF-SERVICE.raw.har
  sanitized/
    GHAR-BKG-JOIN-060.sanitized.har
    GHAR-BKG-JOIN-060.manifest.json
    GHAR-CAN-SELF-SERVICE.sanitized.har
    GHAR-CAN-SELF-SERVICE.manifest.json
  snapshots/
    before/
    after-join/
    after-cancel/
    after-hard-reload/
  screenshots/
  review/
    sanitization-review.md
    contract-review.md
    cleanup-report.md
```

Raw HAR никогда не добавляется в Git. Sanitized HAR остаётся приватным до
независимого review. В Git допускается case summary с hash и masked ids; сам HAR
добавляется только после отдельного security approval.

## 6. Общий preflight перед любой mutation

1. Заполнить приватный run registry и назначить aliases.
2. Зафиксировать exact environment и подтвердить mutation authority.
3. Проверить, что station/tester/game принадлежат тестовому контуру.
4. Синхронизировать часы browser, observer и server; записать UTC и local time.
5. Записать runtime fingerprints и served bundle hashes.
6. Получить provider snapshots active/history/subscription/balance/exercise.
7. Получить LK snapshots game/roster/cabinet/publication.
8. Убедиться, что target ids совпадают во всех контурах без ambiguity.
9. Проверить initial balance и expected delta.
10. Открыть DevTools Network: Preserve log on, Disable cache on.
11. Очистить network log непосредственно перед действием.
12. Зафиксировать правило: один click; после timeout повтор запрещён до readback.

### Немедленный NO-GO

- tester или target принадлежит реальному клиенту;
- нет exact `clientSubscriptionId`, booking/exercise id или station id;
- active и history недоступны хотя бы с одной стороны;
- balance нельзя измерить до действия;
- выбранный refund option неизвестен;
- target содержит реальные оплаты/участников;
- runtime меняется во время прогона;
- browser пишет сторонний трафик, который нельзя безопасно отфильтровать;
- cleanup не определён или может повторно вернуть деньги/посещение.

### W0 — discovery существующих подписок

До первого browser write выполнить read-only inventory:

1. Получить список provider subscription products по доступным station ids.
2. Получить test contracts и отделить active/expired/refunded/ambiguous.
3. Группировать только по exact product/type/station ids; name используется как
   подпись, но не создаёт mapping.
4. Сформировать candidate mapping `provider product -> subscription_type`.
5. Проверить ambiguous: одинаковое имя с разными ids, один product на несколько
   station, contracts без product id, неизвестная currency/validity.
6. Оставить ambiguous в `QUARANTINED`; автоматический mapping запрещён.
7. Выполнить local dry-run будущего импорта: created/linked/skipped/quarantined.
8. Сверить dry-run повторно — результат должен быть идемпотентным.
9. Apply local links допускается только после отдельного approval и не должен
   изменять provider product/contract.

PASS: provider readback до/после идентичен; существующие contracts видны в ЦУП
по type/station/status; каждый local link имеет evidence status и audit source.

## 7. W1-A — `GHAR-BKG-JOIN-060`

### Preconditions

- contract/subscription status: `ACTIVE`;
- target duration: provider-confirmed `60`;
- initial active service count записан;
- initial daily claim отсутствует;
- initial visits/balance записан как `B0`;
- target roster не содержит tester;
- target free capacity больше нуля;
- expected balance delta записан как `D60` до теста.

### Before snapshots

Сохранить с correlation timestamp:

1. client subscription detail и balance;
2. active bookings tester;
3. booking history/inclusive tester;
4. target exercise detail и roster;
5. LK game direct view;
6. LK public/list projection;
7. tester cabinet projection;
8. текущую policy/eligibility информацию, если endpoint уже существует.

### Browser action

1. Открыть exact test game по прямой ссылке.
2. Убедиться, что выбран нужный tester и subscription alias.
3. Начать отдельный journal timestamp.
4. Очистить Network.
5. Нажать CTA join ровно один раз.
6. Не закрывать страницу до terminal UI state или timeout.
7. При timeout записать время и перейти к readback; не нажимать повторно.
8. Сохранить raw HAR как `GHAR-BKG-JOIN-060.raw.har`.

### Required evidence

- фактический LK command и response;
- все Viva requests, относящиеся к exact target;
- request method/path/body/headers без предположений из исходника;
- provider response status и correlation ids;
- один semantic booking outcome, без duplicate write;
- exact booking id связан с tester/subscription/exercise;
- active/history после join;
- exercise roster после join;
- balance `B1` и вычисленный `B1 - B0`;
- LK game/participant/cabinet/publication после hard reload.

### PASS

- один booking существует в authoritative active readback;
- history не содержит конфликтующий duplicate;
- roster содержит tester ровно один раз;
- LK participant ссылается на тот же booking/exercise;
- фактический balance delta равен заранее утверждённому `D60`;
- hard reload не меняет confirmed state;
- повторной mutation после timeout/refresh нет;
- HAR можно очистить без потери contract fields.

### FAIL / RECONCILIATION

- UI success без authoritative booking;
- booking существует, но LK participant отсутствует;
- LK participant есть, а active/history не подтверждают booking;
- два booking на один action;
- balance delta неоднозначен;
- target ids расходятся;
- provider write прошёл, но response потерян.

При FAIL состояние сначала классифицируется readback. Cleanup не запускается
вслепую и не повторяет join.

## 8. W1-B — `GHAR-CAN-SELF-SERVICE`

Этот capture начинается только после PASS или однозначного provider-confirmed
join из W1-A.

### Before cancellation

- exact booking active;
- tester присутствует в roster/LK;
- balance равен подтверждённому `B1`;
- записаны доступные cancellation/refund options;
- Product/Viva owner подтвердил, какой option должен вернуть service visit;
- raw Network log очищен после W1-A.

### Browser action

1. Открыть карточку exact booking/game.
2. Начать новый journal timestamp.
3. Нажать self-leave/cancel один раз.
4. Выбрать только заранее подтверждённый subscription-return option.
5. Не повторять после timeout.
6. Сохранить отдельный `GHAR-CAN-SELF-SERVICE.raw.har`.

### Required evidence

- cancellation-options read;
- exact cancellation request и фактический refund method;
- response/status/correlation;
- booking отсутствует в active и присутствует в history с terminal state;
- balance `B2` после cancellation;
- exercise roster больше не содержит tester;
- LK participant удалён/terminal;
- cabinet и publication очищены после hard reload;
- entitlement/daily claim освобождён только после provider confirmation.

### PASS

- `B2 == B0`, если заранее утверждена политика полного возврата посещения;
- balance увеличился ровно один раз;
- exact booking terminal в authoritative history;
- ни один повторный cancel/refund не отправлен;
- tester отсутствует во всех активных проекциях после hard reload;
- audit связывает cancellation с исходным join operation;
- test game cleanup не затрагивает других клиентов.

### FAIL / STOP

- provider не предлагает ожидаемый subscription-return option;
- booking исчез только из active, но отсутствует в history;
- balance не вернулся или вернулся дважды;
- LK скрыт, но Viva booking active;
- Viva terminal, но LK/public/cabinet остаются active;
- endpoint/body отличается от ожидаемого и результат неоднозначен.

При любом таком результате создаётся reconciliation note; другой refund method
не выбирается «для проверки» без нового exact approval.

## 9. Sanitization и review после W1

1. Не открывать raw HAR в мессенджерах и не прикладывать к задаче.
2. Запустить `npm run test:har-sanitizer` из checkpoint branch.
3. Для каждого case определить минимальные observed host/path prefixes.
4. Запустить `npm run har:sanitize-viva -- ...` в приватном каталоге.
5. Сверить source/sanitized SHA и entry counts.
6. Отдельно искать authorization, cookie, JWT, email, phone, card/PAN, names,
   birth date, comments, payment URLs и internal credentials.
7. Проверить, что method/path/body enum/status/correlation/readback сохранены.
8. Reviewer подписывает sanitization review.
9. Contract reviewer сопоставляет HAR со snapshots и journal.
10. Только после этого case переходит `SANITIZED -> REVIEWED -> APPROVED`.

Если очистка удалила поле, необходимое для контракта, sanitizer меняется на
synthetic fixture и проходит regression test; raw значение вручную не копируется.

## 10. W2 — duration и базовый lifecycle

Каждый duration использует отдельный service date или отдельную подписку, чтобы
daily limit не смешивался с provider visit delta.

| Test | Подготовка | Действие | PASS/evidence |
|---|---|---|---|
| `CREATE-060` | Пустой slot, tester-organizer, `B0` | Create game 60 по subscription | Exercise + booking + LK game; unambiguous balance delta; no orphan |
| `CREATE-090` | Отдельный день/contract | Create game 90 | Provider duration 90 и фактический delta зафиксированы |
| `CREATE-120` | Отдельный день/contract | Create game 120 | Provider duration 120 и фактический delta зафиксированы |
| `JOIN-090` | Test game 90 | Join один раз | Exact booking/roster/balance/hard reload |
| `JOIN-120` | Test game 120 | Join один раз | Exact booking/roster/balance/hard reload |
| `CREATE-BOOKING-FAIL` | Управляемый booking reject | Create exercise succeeds, booking fails | Доказано: cleanup или reconciliation; exercise не остаётся тихим orphan |
| `TIMEOUT-AFTER-WRITE` | Controlled proxy/test fault | Ответ теряется после provider write | Нет слепого retry; outcome определяется exact readback |

Для каждого успешного create/join выполняется отдельный approved cancellation
cleanup и подтверждается, вернулся ли именно фактически списанный visit delta.

## 11. W3 — policy и entitlement acceptance

Эти тесты запускаются после реализации server-side enforcement.

### Active services = 3

1. Создать три verified active service на разрешённых датах.
2. Перед каждой командой сверять count через authoritative provider/read model.
3. Запросить quote для четвёртой.
4. Выполнить прямой API command, обходя UI.
5. Ожидать `ACTIVE_SERVICE_LIMIT_REACHED` до Viva write.
6. Завершить/отменить одну услугу и подтвердить terminal/refund readback.
7. Повторить quote/command: новая услуга разрешена только после confirmation.

PASS: UI и API одинаковы; четвёртая mutation отсутствует в provider trace;
локальное скрытие без provider terminal state не освобождает слот.

### Booking window 3/4/5 дней

Для каждого `N` проверяются station-local даты:

- `today`;
- `today + N - 1` — разрешено;
- `today + N` — `BOOKING_WINDOW_EXCEEDED`;
- UTC date, отличающаяся от station-local date;
- момент до и после local midnight.

PASS: решение принимает сервер; direct API нельзя обойти; существующая бронь не
отменяется при смене 5→3.

### Daily usage

1. Использовать subscription для разрешённого события.
2. В тот же station-local день попробовать другую разрешённую категорию.
3. Ожидать `DAILY_USAGE_LIMIT_REACHED` до Viva write.
4. Повторить с другой подпиской того же клиента — применяется её отдельный scope.
5. Отменить первую booking и дождаться active/history/balance confirmation.
6. Проверить повторное использование согласно принятой policy release claim.

### Runtime toggle

1. Published policy разрешает create 60/90/120.
2. Создать существующую confirmed booking.
3. Опубликовать новую version: create disabled, `applyTo=ACTIVE_AND_NEW`.
4. Проверить existing и newly purchased contracts.
5. UI скрывает/disable create; direct API возвращает
   `SUBSCRIPTION_ACTION_DISABLED` без Viva write.
6. Существующая booking сохраняет price/policy snapshot и не отменяется.
7. Join и benefit rules не меняются, если не изменялись отдельно.

Отдельный duration-toggle: новая policy меняет create durations
`[60, 90, 120] -> [60]`. Create 60 остаётся доступен, UI 90/120 скрыт, а direct
API для 90/120 получает `DURATION_NOT_ALLOWED` до Viva write. Затем отдельной
version create выключается целиком и проверяется `SUBSCRIPTION_ACTION_DISABLED`.

## 12. W4 — benefits

Минимальная type matrix содержит exact provider ids для «Игра + тренер»,
«Групповая», «Сплит D» и контрольного неподходящего типа. Каждый тип можно
включить/выключить независимо; совпадение отображаемого имени не считается
разрешением.

| Test | Настройка | Проверка |
|---|---|---|
| `GAME-DISABLED` | `GAME` benefit disabled, entitlement create/join enabled | Обычная игра без скидки; subscription join продолжает работать |
| `GROUP-FIXED` | Exact group type + station, fixed price | Quote, charge и ledger используют один price snapshot |
| `GROUP-DISCOUNT` | Percent/fixed discount | Одна rule; rounding в minor units; refund от paid amount |
| `TOURNAMENT-FIXED` | Exact tournament type/station | Current и new LK показывают одинаковую цену |
| `STATION-OUT` | Тот же type, другая station | `STATION_NOT_ALLOWED` или base price по заранее принятой policy |
| `TYPE-OUT` | Та же station, другой provider type | Benefit не применяется |
| `PRIORITY-CONFLICT` | Две overlapping rules с одним priority | Publish блокируется; runtime не выбирает случайную rule |

Для каждого price case сохраняются base price, applied rule id/version, discount,
paid amount, provider transaction и refund amount.

## 13. W5 — партии и покупка

### ЦУП control plane

Перед purchase concurrency проверить административные сценарии:

| Test | Действие | PASS |
|---|---|---|
| `CUP-TYPE-DRAFT` | Создать тип, station offers и provider mappings | Draft не виден storefront; exact ids сохранены |
| `CUP-POLICY-PREVIEW` | Изменить duration/limit/window/benefits | Impact показывает active/new contracts и не выполняет mutation |
| `CUP-POLICY-PUBLISH` | Publish с reason и `effectiveAt` | Immutable version, audit actor, current/new apply scope |
| `CUP-RELEASE-EDIT` | Настроить 50/50/50/50 и 100→7/day | Validation количества, цены, порядка и timezone |
| `CUP-PAUSE-RESUME` | Pause/resume sales | Новые reserves blocked/unblocked; paid/pending идут по policy |
| `CUP-BUYERS` | Фильтры type/station/phase/status/date | Покупатели и totals совпадают с ledger/provider readback |
| `CUP-RBAC` | Operator другой station меняет offer | `403`; audit; состояние не изменено |
| `CUP-ARCHIVE` | Архивировать type с contracts | История сохраняется; hard delete запрещён |

Все elevated actions (`ACTIVE_AND_NEW`, refund, reconcile) требуют permission,
reason и повторного чтения сохранённой version.

### Ladder 50/50/50/50

Для фаз 19 800 / 23 800 / 36 000 / 48 000 проверяются:

- boundary sold count `49/50/51`;
- следующая фаза не доступна до terminal activation condition;
- reservation фиксирует phase/price/currency/policy snapshot;
- refund не меняет фазу без explicit `returnToInventoryPolicy`;
- Buyers/Audit показывают, кто и в какой фазе купил.

### Bulk 100 → 7/day

1. Опубликовать `BULK=100` в test environment.
2. Подтвердить, что daily phase не добавляет места до sold-out bulk.
3. Продать/симулировать 100 terminal paid records через test harness.
4. Проверить server `nextReleaseAt` и countdown.
5. В release time открыть не более 7.
6. Проверить pause/resume и следующий local-day drop.

### Concurrency и idempotency

- 20 параллельных reservation на последнюю единицу: ровно один winner;
- остальные получают `RELEASE_SOLD_OUT` без provider transaction;
- один `Idempotency-Key` + тот же payload возвращает тот же purchase;
- тот же key + другой payload → `IDEMPOTENCY_CONFLICT`;
- payment callback duplicate не создаёт второй contract/ledger entry.

### Payment states

- pending не считается sold/active;
- expired reservation освобождает единицу один раз;
- paid до cleanup завершает contract;
- paid после expiry/cancel создаёт reconciliation case;
- refund связывается с original transaction и не завышает LTV.

Purchase tests с реальными деньгами запрещены без payment sandbox либо отдельного
Finance approval и процедуры полного refund.

## 14. W6 — cancellation, unpaid и reconciliation

| Test | Действие | Обязательный результат |
|---|---|---|
| `ORG-REMOVE` | Организатор удаляет subscription participant | Auth actor, exact booking terminal, visit return, roster/cabinet/public clean |
| `WHOLE-GAME-MIXED` | Cancel game с subscription/card/deposit | Child operation на каждого; правильный refund method/amount |
| `PARTIAL-FAIL` | Один child cancel контролируемо падает | Игра закрыта для join; successes не повторяются; reconciliation visible |
| `RETRY` | Повтор parent command | Нет повторного refund/visit return |
| `UNPAID-EXPIRE` | Reservation/payment истекает | Transaction checked first; exact booking/projections cleaned |
| `LATE-PAID-BEFORE` | Paid найден перед cancel | Cancel не отправляется; state восстанавливается |
| `LATE-PAID-AFTER` | Paid после confirmed cancel | Деньги не теряются; no silent restore; operator case |
| `HIDE-ONLY` | Hide cabinet/publication | Provider booking не меняется; entitlement не освобождается |
| `ATTENDED` | Отметить посещение exact booking | Provider terminal/attendance, правильный write-off, active slot освобождён |
| `NO-SHOW` | Отметить неявку | Provider status и принятая no-show refund policy; никаких скрытых возвратов |
| `CANCEL-BEFORE-CUTOFF` | Отмена до cutoff | Visit возвращён один раз; claim released после readback |
| `CANCEL-AFTER-CUTOFF` | Попытка после cutoff | Provider rejection/options и неизменный balance |
| `CURRENCY-REFUND` | Отмена card booking | Refund transaction/receipt и paid amount подтверждены |
| `DEPOSIT-REFUND` | Возврат на депозит | Exact deposit delta и booking history |
| `DELETE-EXERCISE` | Удалить пустую test game после child cleanup | Exact exercise terminal; no roster/cabinet/public orphan |

PASS whole-game cancellation требует итог по каждому participant, а не один
общий HTTP 200.

Attendance/no-show тесты выполняются Viva operator на заранее выделенных exact
bookings. Нельзя отмечать посещение на booking реального клиента или менять
статус, чтобы искусственно освободить active-service slot.

## 15. W7 — LTV, audit и два ЛК

### Ledger/LTV

Для одного test cohort создать контролируемую цепочку:

1. purchase gross;
2. entitlement usage;
3. fixed/discount benefit;
4. cancellation reversal;
5. partial/full refund;
6. expiration/renewal, если поддержано тестовым clock.

Проверить:

- gross, refund и net revenue;
- subsidy/discount отдельно от revenue;
- usage/reversal не удваиваются;
- phase/station/type cohort сохранён;
- D30/D90/D180/D365 не рассчитываются до наступления даты без test clock;
- customer LTV и offer LTV не смешаны;
- raw phone/email отсутствуют в analytics export.

### Current LK / new LK parity

Один и тот же contract/operation открывается в обоих клиентах:

- одинаковая eligibility и error code;
- одинаковый price/policy snapshot;
- один idempotency/correlation chain;
- hard reload восстанавливает server state;
- один клиент не может обойти ограничение, скрытое в другом UI;
- cancellation/operation status отображается одинаково.

## 16. Что должна подготовить каждая команда

### Product

- принять `DEC-SUB-001..007`;
- определить expected visit delta 60/90/120;
- определить terminal active service states;
- определить refund/return-to-inventory policy;
- определить disabled game benefit initial state;
- утвердить station/type scope и price rounding.

### Viva/integration

- выделить synthetic clients/subscriptions/products;
- дать read-only способы active/history/balance/transaction snapshots;
- подтвердить cancellation options и cleanup;
- исключить реальные уведомления tester;
- подтвердить payment sandbox или запретить monetary tests.

### Backend

- correlation/idempotency во всех operations;
- authoritative readback после timeout;
- server-side limits и station timezone;
- immutable price/policy snapshots;
- operation/child states, outbox и reconciliation;
- logs без PII/secrets.

### ЦУП

- Types, Policies, Release Programs, Buyers, Usage, LTV, Reconciliation, Audit;
- station-scoped RBAC;
- draft/preview/publish и reason для elevated actions;
- явные current counters и `nextReleaseAt`;
- history всех изменений.

### Frontend current/new LK

- quote перед command;
- disabled/loading/error/empty states;
- защита от double-click;
- отображение server error code без локального пересчёта;
- operation pending/reconciliation state;
- hard reload и mobile/desktop parity.

### QA/evidence

- приватный run registry;
- snapshots, HAR, journal и screenshots;
- независимый sanitization/contract review;
- cleanup report;
- traceability test id → operation id → provider id → ledger/outbox.

## 17. Критерии готовности к первому реальному capture

Все пункты должны быть `YES`:

- [ ] environment и mutation window утверждены;
- [ ] tester является synthetic/test account;
- [ ] exact subscription и initial balance известны;
- [ ] expected `D60` принят Product/Viva owner;
- [ ] exact 60-minute game/exercise подготовлен;
- [ ] в target нет реальных клиентов/денег;
- [ ] active/history/balance readback доступен;
- [ ] cancellation-return option подтверждён;
- [ ] cleanup owner и процедура назначены;
- [ ] runtime fingerprints записаны;
- [ ] private evidence storage подготовлен;
- [ ] browser tester знает правило one-click/no-blind-retry;
- [ ] evidence reviewer доступен сразу после capture.

Если хотя бы один пункт `NO`, выполняется только W0 read-only discovery.

## 18. Следующие действия

1. Скопировать `GOLDEN_HAR_RUN.example.json` в приватный каталог вне Git.
2. Заполнить environment, tester, station, subscription, game и cleanup fields.
3. Product/Viva owner записывает expected `D60` и refund option.
4. Observer выполняет W0 snapshots и подтверждает exact-id consistency.
5. Test owner подписывает GO для `GHAR-BKG-JOIN-060`.
6. Browser tester выполняет W1-A и передаёт raw HAR только в private storage.
7. Observer делает after-join snapshots и объявляет PASS/RECONCILIATION.
8. При однозначном join отдельно утверждается W1-B cancellation.
9. Выполняются cancellation readback и cleanup.
10. HAR очищаются, проходят два review и получают evidence status.
11. Только после одобрения W1 назначаются даты и test records для 90/120.

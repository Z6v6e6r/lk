# Golden HAR Passport — Managed Annual Subscriptions

Date: 2026-08-11

Status: evidence collection required; no current Golden HAR is approved by this
checkpoint.

Пошаговый порядок выполнения, роли, private run registry и первый безопасный
capture описаны в `GOLDEN_HAR_EXECUTION_PLAN.md`.

Первый live read-only preflight зафиксирован в `W0_PREFLIGHT_2026-08-11.md`;
он не изменил статусы Golden cases и завершён решением `NO_GO` для W1.

## Назначение

Этот паспорт фиксирует минимальный набор наблюдений Viva, без которого нельзя
реализовывать или сертифицировать жизненный цикл годовой подписки.

Задача Golden HAR — доказать точный контракт, а не только внешний результат в
интерфейсе. Для каждого сценария требуется связать:

```text
browser action
  -> LK/CUP request
  -> exact Viva request(s)
  -> Viva active/history/transaction/balance readback
  -> LK/Mongo state
  -> cabinet/publication state after hard reload
```

## Правила безопасности

До передачи или сохранения HAR необходимо удалить:

- `Authorization`, cookie, refresh/access tokens и API keys;
- реальные телефон, email, ФИО, дату рождения и комментарии клиента;
- реквизиты карты, платёжные ссылки и полный fiscal payload;
- внутренние секреты Node-RED, Mongo и provider credentials.

В evidence сохраняются только synthetic tester ids, masked external ids и
минимальные поля, влияющие на контракт. Исходный HAR с секретами в Git не
добавляется. Если безопасная очистка не доказана, файл считается `REJECTED`.

## Статусы evidence

| Status | Значение |
|---|---|
| `MISSING` | Сценарий не захвачен |
| `CAPTURED` | Есть исходная запись, но она ещё не очищена и не должна коммититься |
| `SANITIZED` | Секреты и PII удалены, структура сохранена |
| `REVIEWED` | Метод, URL, body, status и readback сопоставлены |
| `APPROVED` | Контракт принят владельцами продукта и интеграции |
| `REJECTED` | HAR неполон, небезопасен либо не доказывает результат |

Только `APPROVED` evidence может переводить provider field из
`evidence-gated` в runtime contract.

## Инвентаризация исторических HAR

11 августа 2026 года выполнена read-only инвентаризация ранее сохранённых HAR.
Исходные файлы не копировались в репозиторий и не изменялись. Ни один из них не
считается Golden HAR для годовой подписки; статусы обязательной матрицы ниже
остаются `MISSING`.

| Source label | SHA-256 prefix | Наблюдение | Почему не Golden | Disposition |
|---|---|---|---|---|
| `subscription-booking` | `90e0f7e97c14` | `GET subscriptions/available`, затем `POST v2/bookings` `202`, `paymentType=SUBSCRIPTION` | Нет полного pre/post active/history/balance, purchase/annual contract и доказательства 90/120 минут | `HISTORICAL_ONLY` |
| `viva-cancel-1` | `d2612489f0bf` | Cancellation options и `DELETE booking` `204` с money refund | В options нет subscription return; нет visit balance/readback | `REJECT_FOR_SERVICE_CASE` |
| `viva-cancel-2` | `1d29bbad437d` | Повтор currency cancellation | Те же пробелы; не является независимым доказательством | `REJECT_FOR_SERVICE_CASE` |
| `viva-cancel-3` | `79a72a4c6c3a` | Active/history и cancellation path | One-time/currency сценарий; исходник содержит PII и credential-like token; нет `SERVICE`/balance delta | `SANITIZER_TEST_ONLY` |
| `cup-create-game` | `687e38e871c5` | Admin create exercise и booking `ON_PLACE` | Не subscription и не current end-user create/join contract | `HISTORICAL_ONLY` |
| `cup-create-split-game` | `22be49b63718` | Create exercise, unpaid products/transactions | Нет subscription entitlement, exact balance и current LK projection | `HISTORICAL_ONLY` |
| `cup-split-game` | `bb02fbed92d5` | Admin exercise/booking/payment chain | Не подтверждает годовой продукт или entitlement rules | `HISTORICAL_ONLY` |
| `tournament-subscription-entry` | `0387e66ac51f` | Widget transaction для tournament product | Нет annual contract activation, benefit price snapshot и refund lifecycle | `HISTORICAL_ONLY` |

Browser timestamps этих файлов относятся к апрелю–маю 2026 года. Они полезны
как указатели на кандидатов endpoint, но не подтверждают актуальный Viva
контракт на дату проектирования. Отдельного пригодного исторического HAR с
`refundMethod=SERVICE` и доказанным balance delta на диске не найдено.

## Безопасное обезличивание

Для нового capture используется локальный санитайзер без внешних зависимостей:

```bash
npm run test:har-sanitizer

npm run har:sanitize-viva -- \
  --input /absolute/private/source.har \
  --output /absolute/private/GHAR-BKG-JOIN-060.sanitized.har \
  --manifest /absolute/private/GHAR-BKG-JOIN-060.manifest.json \
  --case-id GHAR-BKG-JOIN-060 \
  --host api.vivacrm.ru \
  --path-prefix '/end-user/api/v1/{tenant}/subscriptions/available' \
  --path-prefix '/end-user/api/v2/{tenant}/bookings'
```

Правила применения:

1. Source, output и manifest должны быть разными файлами вне Git; существующий
   output санитайзер не перезаписывает.
2. Для каждого case задаются минимальные `--host` и `--path-prefix`; запросы
   авторизации, аналитики и соседних сценариев исключаются до сериализации.
3. Удаляются authorization/cookies, PII, credential-like values, browser
   fingerprint headers, IP/connection, binary и non-JSON bodies. Идентификаторы
   заменяются стабильными aliases только внутри очищенного файла.
4. Manifest со статусом `SANITIZED` хранит SHA исходника/результата, счётчики и
   endpoint summary, но не raw ids и не alias map.
5. После автоматической очистки отдельный reviewer проверяет HAR поиском PII и
   secrets, сверяет семантику request/response/readback и только затем меняет
   статус evidence. Санитайзер сам не присваивает `REVIEWED`/`APPROVED`.

Проверка инструмента на двух исторических исходниках выполнена полностью в
памяти, без записи очищенных копий: subscription-booking `15 -> 4` entries
(11 удалено), cancellation-with-token `35 -> 12` entries (23 удалено). В обоих
случаях проверка source-token leakage прошла; это доказывает работу инструмента,
но не бизнес-контракт этих HAR.

## Capture protocol

Для каждого сценария:

1. Назначить synthetic tester, станцию, subscription product, event type и
   ожидаемый outcome.
2. Зафиксировать UTC и station-local время начала.
3. До действия получить read-only snapshots:
   - subscription/contract state;
   - visits/balance;
   - active booking list;
   - inclusive/history booking list;
   - exercise/roster;
   - payment transaction, если применимо;
   - LK game, roster, cabinet и publication projections.
4. В DevTools включить Preserve log и очистить старый network log.
5. Выполнить ровно одно пользовательское действие. Не повторять кнопку после
   timeout до readback.
6. Сохранить HAR и журнал browser timestamps.
7. Получить те же read-only snapshots после действия и после hard reload.
8. Проверить, что все provider writes привязаны к exact target ids и нет
   скрытого повторного списания/отмены.
9. Обезличить HAR, создать evidence summary и провести независимый review.

## Evidence manifest template

Для каждого утверждённого HAR рядом создаётся `<case-id>.md`:

```yaml
caseId: GHAR-BKG-CREATE-060
status: SANITIZED
capturedAt: 2026-08-11T10:00:00Z
stationTimezone: Europe/Moscow
testerAlias: tester-entitlement-a
lkReleaseSha: placeholder
nodeRedFlowSha: placeholder
providerEnvironment: staging-or-authorized-production
preconditions:
  contractState: ACTIVE
  visitsBalance: placeholder
writeRequests:
  - sequence: 1
    method: POST
    pathTemplate: /redacted/provider/path
    requestBodySha256: placeholder
    responseStatus: 200
readbacks:
  - kind: ACTIVE_BOOKINGS
    exactTargetFound: true
  - kind: VISIT_BALANCE
    delta: placeholder
postconditions:
  lkProjectionVerified: true
  hardReloadVerified: true
openQuestions: []
reviewers: []
```

Raw ids и payload не дублируются в summary. Для сопоставления используется
masked suffix или локальная evidence map вне Git.

## Обязательная матрица Golden HAR

### A. Покупка и годовой контракт

| Case ID | Сценарий | До | Действие | Обязательное доказательство | Status |
|---|---|---|---|---|---|
| `GHAR-PUR-001` | Покупка заранее созданного годового продукта | Нет active contract | Buy + payment | Transaction readback и exact provider contract active | `MISSING` |
| `GHAR-PUR-002` | Партия с другой ценой | Тот же subscription type, другая phase | Buy | Доказано: цена приходит из отдельного product либо provider принимает безопасный amount | `MISSING` |
| `GHAR-PUR-003` | Банк оставил pending | Reserved unit | Payment не завершён | Pending не становится sold/active, reservation имеет terminal expiry | `MISSING` |
| `GHAR-PUR-004` | Late paid после expiry | Reservation expired | Provider сообщает paid | Не создаётся тихий дубль; case уходит в reconciliation | `MISSING` |
| `GHAR-PUR-005` | Refund годового продукта | Active contract | Approved refund | Transaction/refund/contract states и inventory policy доказаны | `MISSING` |

Open provider decisions:

- динамическая цена против отдельного provider product на фазу;
- момент начала 365 дней: payment, activation или первая услуга;
- поведение contract при полном/частичном refund;
- возможность получить idempotent transaction/contract readback.

### B. Создание игры

| Case ID | Duration | Обязательные before/after | Status |
|---|---:|---|---|
| `GHAR-BKG-CREATE-060` | 60 | Contract, visits, active/history, exercise, exact booking, LK game | `PARTIAL_NO_HAR_BALANCE_READBACK_PENDING` |
| `GHAR-BKG-CREATE-090` | 90 | То же плюс фактический provider visit delta | `MISSING` |
| `GHAR-BKG-CREATE-120` | 120 | То же плюс фактический provider visit delta | `MISSING` |

Для каждого case фиксируются create exercise и create booking отдельно. Должно
быть доказано, может ли exercise существовать после неуспешного booking и какой
cleanup безопасен.

Live partial evidence is recorded in `W1_CREATE_060_PARTIAL_2026-08-11.md`.
Create/exercise/booking/LK exact-id correlation is available in the private run
registry, but the case is not Golden evidence until raw HAR and the exact
`B0 -> B1` Viva balance transition are preserved.

### C. Присоединение к игре

| Case ID | Duration | Обязательные before/after | Status |
|---|---:|---|---|
| `GHAR-BKG-JOIN-060` | 60 | Active/history, visits, roster, exact booking, LK participant | `MISSING` |
| `GHAR-BKG-JOIN-090` | 90 | То же плюс provider visit delta | `MISSING` |
| `GHAR-BKG-JOIN-120` | 120 | То же плюс provider visit delta | `MISSING` |

Нужно отдельно подтвердить, что повторный join с тем же idempotency key не
создаёт второй booking, а timeout после write разрешается readback, а не новой
мутацией.

### D. Выход и удаление участника

| Case ID | Сценарий | Обязательное доказательство | Status |
|---|---|---|---|
| `GHAR-CAN-SELF-SERVICE` | Игрок выходит сам, возвращается посещение | cancellation options, exact cancel request, active/history, visit balance, LK/public reload | `MISSING` |
| `GHAR-CAN-ORG-SERVICE` | Организатор удаляет игрока | Actor authorization, same exact booking proof, roster event, return | `MISSING` |
| `GHAR-CAN-NO-REFUND` | Отмена без возврата | Provider предлагает именно этот вариант, balance не увеличен | `MISSING` |
| `GHAR-CAN-CURRENCY` | Возврат денег | Transaction/refund/receipt readback, booking cancelled | `MISSING` |
| `GHAR-CAN-DEPOSIT` | Возврат на депозит | Deposit delta и booking history | `MISSING` |

Исторические наблюдения указывают на client-scoped cancellation с
`refundMethod=SERVICE` и обязательным active/history readback. В этом паспорте
это **кандидат**, а не утверждённый актуальный контракт: endpoint version,
request body, cancellation options и balance delta должны быть повторно сняты.

### E. Отмена всей игры

| Case ID | Сценарий | Обязательное доказательство | Status |
|---|---|---|---|
| `GHAR-GAME-CANCEL-MIXED` | Subscription + card + deposit участники | Child outcome на каждого booking, все refunds, exercise state, закрытый LK game | `MISSING` |
| `GHAR-GAME-CANCEL-PARTIAL` | Один provider cancel падает | Игра закрыта для join, успешные child не повторяются, case виден оператору | `MISSING` |
| `GHAR-GAME-CANCEL-RETRY` | Повтор той же команды | Нет повторного refund/visit return, итог восстанавливается readback | `MISSING` |

Publication removal и cabinet hide проверяются отдельно от provider cancel.
`isPrivate` или отсутствие в одном списке не считается полным удалением.

### F. Групповые занятия, игры и турниры с льготой

| Case ID | Категория | Правило | Status |
|---|---|---|---|
| `GHAR-BEN-GROUP-FIXED` | Group training | Fixed price | `MISSING` |
| `GHAR-BEN-GROUP-DISCOUNT` | Group training | Percent/fixed discount | `MISSING` |
| `GHAR-BEN-TOURNAMENT-FIXED` | Tournament | Fixed price | `MISSING` |
| `GHAR-BEN-TOURNAMENT-CANCEL` | Tournament | Cancel + refund | `MISSING` |
| `GHAR-BEN-GAME-DISABLED` | Ordinary commercial game | Benefit disabled | `MISSING` |

Каждый HAR должен доказать канонические provider type/station ids. Нельзя
строить routing по отображаемому названию события.

### G. Посещение, no-show и расходование entitlement

| Case ID | Сценарий | Обязательное доказательство | Status |
|---|---|---|---|
| `GHAR-ATT-ATTENDED` | Посещение отмечено | Booking/history status, balance delta, terminal active service | `MISSING` |
| `GHAR-ATT-NO-SHOW` | Неявка | Provider status и политика возврата/невозврата | `MISSING` |
| `GHAR-ATT-CANCEL-BEFORE` | Отмена до занятия | Visit returned один раз, active service released | `MISSING` |
| `GHAR-ATT-CANCEL-AFTER` | Попытка отмены после cutoff | Provider rejection/options и неизменный balance | `MISSING` |

### H. Неоплата и поздняя оплата

| Case ID | Сценарий | Обязательное доказательство | Status |
|---|---|---|---|
| `GHAR-PAY-UNPAID-EXPIRE` | Pending истёк | Transaction readback not paid, booking cleanup, LK/public removal | `MISSING` |
| `GHAR-PAY-LATE-BEFORE-CANCEL` | Paid найден до cancel | Участник восстановлен, cancel не отправлен | `MISSING` |
| `GHAR-PAY-LATE-AFTER-CANCEL` | Paid после confirmed cancel | Reconciliation case, без тихой потери денег | `MISSING` |

## Сквозная E2E-матрица нескольких тестеров

Тесты проводятся на staging/sandbox. Production допускается только для заранее
согласованных exact test records с отдельным разрешением на каждую мутацию.

### Tester identities

| Alias | Роль | Назначение |
|---|---|---|
| `tester-cup-a` | Station subscription operator | Каталог, партии, publish/pause/resume |
| `tester-buyer-a` | Customer | Границы партии и покупка |
| `tester-buyer-b` | Customer | Конкурентная покупка последней единицы |
| `tester-entitlement-a` | Customer/organizer | Create/join, duration, daily и active limits |
| `tester-benefit-a` | Customer | Group/tournament price rules и station scope |
| `tester-cancel-a` | Customer | Self leave, refund и reload |
| `tester-organizer-a` | Game organizer | Remove participant и cancel whole game |
| `tester-auditor-a` | Read-only operator | LTV, audit и reconciliation evidence |

### Release and purchase tests

| Test ID | Сценарий | Expected |
|---|---|---|
| `E2E-REL-001` | 50/50/50/50 price ladder | Следующая фаза не продаётся до activation condition; price snapshot верен |
| `E2E-REL-002` | 100 bulk, затем 7/day | После bulk используется server `nextReleaseAt`; daily available не превышает 7 |
| `E2E-REL-003` | Pause/resume | Новые reserves блокируются; существующие paid/reserved обрабатываются по policy |
| `E2E-REL-004` | 20 одновременных запросов на последнюю единицу | Ровно один reservation; остальные получают `RELEASE_SOLD_OUT` |
| `E2E-REL-005` | Повтор одного request с тем же idempotency key | Возвращается тот же purchase; счётчики не меняются второй раз |
| `E2E-REL-006` | Один key с другим payload | `IDEMPOTENCY_CONFLICT`, внешней мутации нет |
| `E2E-REL-007` | Expired reservation | Единица возвращена один раз; поздний paid уходит в reconciliation |
| `E2E-REL-008` | Read-only discovery существующих products/contracts | ЦУП показывает exact provider candidates, ничего не меняя в Viva |
| `E2E-REL-009` | Dry-run и apply local links | Counts совпадают; ambiguous остаются quarantined; provider contracts не мутируют |

Границы количества проверяются на 49/50/51 и 99/100/101 фактической продаже,
а не только на UI counter.

### Policy and entitlement tests

| Test ID | Сценарий | Expected |
|---|---|---|
| `E2E-POL-001` | Create 60/90/120 enabled | Все разрешённые duration проходят server quote и command |
| `E2E-POL-002` | Create выключен для `ACTIVE_AND_NEW` | Кнопка скрыта; прямой API получает `SUBSCRIPTION_ACTION_DISABLED` |
| `E2E-POL-003` | Existing booking после publish | Не отменяется и сохраняет исходный price/policy snapshot |
| `E2E-POL-004` | Три active services, попытка четвёртой | `ACTIVE_SERVICE_LIMIT_REACHED`, Viva write отсутствует |
| `E2E-POL-005` | Одна active service завершена/отменена | Новая команда доступна только после verified terminal state |
| `E2E-POL-006` | Window 3 days | Сегодня..сегодня+2 доступны; сегодня+3 блокируется |
| `E2E-POL-007` | Window changed 3 -> 5 | Новая policy применяется согласно `effectiveAt` и `applyTo` |
| `E2E-POL-008` | Второе использование в тот же service date | `DAILY_USAGE_LIMIT_REACHED`, duplicate Viva booking отсутствует |
| `E2E-POL-009` | Cancelled booking освобождает daily claim | Только после active/history и balance readback |

Window cases выполняются около полуночи station timezone и на UTC-дате,
отличающейся от локальной.

### Benefit tests

| Test ID | Сценарий | Expected |
|---|---|---|
| `E2E-BEN-001` | Ordinary game discount выключен | Base price сохранена; subscription create/join rule не затронута |
| `E2E-BEN-002` | Group fixed price на разрешённой станции/type | Quote и provider transaction используют один price snapshot |
| `E2E-BEN-003` | Та же group на другой станции | `STATION_NOT_ALLOWED` или base price без benefit согласно rule |
| `E2E-BEN-004` | Tournament fixed discount | Правило применено один раз, отображено в ledger/LTV |
| `E2E-BEN-005` | Два пересекающихся rules с одинаковым priority | Publish блокируется validation error |
| `E2E-BEN-006` | Cancel discounted event | Refund соответствует paid amount, а не base price |

### Lifecycle and reconciliation tests

| Test ID | Сценарий | Expected |
|---|---|---|
| `E2E-LIFE-001` | Self leave subscription booking | Exact Viva cancelled/history + visit returned + claim released + reload clean |
| `E2E-LIFE-002` | Organizer remove | Actor authorised; same end-to-end proof; audit reason saved |
| `E2E-LIFE-003` | Whole game mixed payments | Child result на каждого игрока; no orphan booking/roster/publication |
| `E2E-LIFE-004` | Provider timeout after write | Operation `PENDING_RECONCILIATION`; новая write не отправляется до readback |
| `E2E-LIFE-005` | Projection failure after provider success | Provider не повторяется; outbox repairs only missing projection |
| `E2E-LIFE-006` | Unpaid cleanup | Transaction checked first; exact records removed from all projections |
| `E2E-LIFE-007` | Late paid after cleanup | Case visible in CUP; деньги не теряются и пользователь не восстанавливается silently |
| `E2E-LIFE-008` | Hard reload/current and new LK | Оба клиента показывают один operation/contract state |

## Обязательный evidence bundle одного E2E case

Каждый PASS включает:

- test id, tester alias, station, policy/release version;
- current LK bundle/release SHA и backend/runtime SHA;
- sanitized browser trace;
- API request/response с idempotency/correlation ids;
- operation state transitions;
- ledger entries и outbox outcomes;
- Viva active/history/exercise/transaction/balance readback;
- Mongo/read-model postcheck;
- current LK, new LK и publication postcheck после hard reload;
- cleanup/rollback outcome для тестовых данных.

Health endpoint, успешная загрузка bundle или один UI screenshot отдельно не
считаются provider E2E-доказательством.

## Решения, которые должны быть зафиксированы до кода

| Decision ID | Решение | Recommended initial value | Evidence/owner |
|---|---|---|---|
| `DEC-SUB-001` | Дневной лимит общий для create/join/group/tournament | Один общий claim для действий, расходующих entitlement | Product + HAR |
| `DEC-SUB-002` | Usage units для 60/90/120 | Не фиксировать до balance HAR | Product + Viva |
| `DEC-SUB-003` | Active service terminal state | Provider completed/attended/cancelled + required refund complete | Product + Viva |
| `DEC-SUB-004` | Discount stacking | Не складывать; одна highest-priority rule | Product |
| `DEC-SUB-005` | Policy publish для existing bookings | Не отменять и не repricing существующие confirmed bookings | Product |
| `DEC-SUB-006` | Refund возвращает место в release phase | Только pre-activation по явной policy | Finance/Product |
| `DEC-SUB-007` | 365-day startsAt | Не фиксировать до purchase/activation HAR | Product + Viva |

## Go / No-Go для начала runtime implementation

GO допускается, когда:

1. P0 cases покупки, 60/90/120 create/join, self/organizer cancel, whole-game
   cancel, attendance и refund имеют статус `APPROVED`.
2. Все `DEC-SUB-*` имеют owner и принятое значение.
3. Sanitization review подтверждает отсутствие credentials/PII.
4. OpenAPI contract и ADR согласованы владельцами текущего и нового ЛК.
5. Тестовые станции, пользователи, продукты и cleanup procedure утверждены.

NO-GO сохраняется при любом из условий:

- provider write shape выведен только из локального исходника;
- неизвестен visit delta для 90/120 минут;
- нет active/history/balance readback после cancellation;
- price phase невозможно однозначно связать с provider transaction;
- whole-game cancel не имеет per-participant outcome;
- HAR содержит секреты либо реальные персональные данные;
- staging или явно разрешённые exact production test records отсутствуют.

# Персональный пилот резидентства LK1: решение Алексея и порядок проверки

Дата: 2026-11-19. Основание: PR #452, head <code>a7ca3270</code>; локальный стенд Hermes с
установленным пакетом из 25 файлов. **На 147 ничего не применено, реальная покупка не
выполнялась, массовое включение не разрешено.** Это решение для персональной проверки под
наблюдением оператора, а не для общего выпуска.

## 1. Одно решение, которое требуется от Алексея

Алексей подтверждает участие в персональном пилоте на следующих условиях (одно решение,
без UUID и без пересылки токенов):

> «Участвую в персональной проверке резидентства под наблюдением оператора. Обязуюсь во
> время пилота не открывать старую страницу <code>?buyResidency=1</code> и не оплачивать
> вторую ссылку. Принимаю, что опубликованный старый клиент технически может создать
> отдельную транзакцию напрямую в Viva; при конфликте исходный заказ уходит в проверку
> клуба, а не активируется автоматически. Разрешаю оператору наблюдать мой исходный заказ
> и выполнять только read-only проверки.»

Этого достаточно для открытия тестового входа его аккаунту. Сумма и одна реальная
покупка согласуются отдельно после установки; текущая цена читается каталогом в момент
покупки, а не фиксируется этим документом.

## 2. Остаточный риск (явно)

Опубликованный старый клиент делает
<code>POST https://api.vivacrm.ru/end-user/api/v1/iSkq6G/transactions</code>
**напрямую из браузера**. Новый сервис не может перехватить этот POST:

- старая страница, уже открытая на этом или другом устройстве, может создать отдельную
  Viva-транзакцию;
- новая защита читает список Viva до и после своего POST, блокирует новый заказ при
  обнаруженной старой операции и **не выдаёт вторую платёжную ссылку** при гонке;
- но это обнаружение и удержание, а не запрет старого browser→Viva POST.

Персональный пилот поэтому допустим только при соблюдении Алексеем условия «не открывать
старую страницу / не оплачивать вторую ссылку» и при наблюдении оператора. Массовое
включение в таком виде не разрешается; технический вариант закрытия пути — раздел 7.

## 3. Роли и наблюдение за исходным заказом

| Роль | Действие |
| --- | --- |
| Алексей | Входит в ЛК1, открывает только <code>https://padlhub.su/lk_new?buyResidency=lifecycle</code>, нажимает одну кнопку, оплачивает **одну** ссылку, возвращается на <code>?phResidencyLifecycleReturn=1</code> |
| Оператор | До открытия входа проверяет отсутствие старой покупки; во время сессии держит журнал заказа; после оплаты проверяет reconcile/активацию; при любом отклонении закрывает create |
| Клуб/поддержка | При <code>PAID_REQUIRES_REVIEW</code> / <code>EXTERNAL_PAYMENT_DETECTED</code> принимает решение по оплате; не выполняет автоматический refund/cancel |

**Кто наблюдает исходный заказ:** оператор смены. Он фиксирует в журнале (без передачи
Алексею идентификаторов): <code>orderId</code>, <code>state</code>,
<code>payment.status</code>, <code>createdAt</code>, <code>updatedAt</code>,
<code>externalCheck.state/openCount/paidAfterOrderCount</code>, наличие payment URL, число
транзакций Viva по продукту. Наблюдение — от открытия тестового входа до терминального
состояния (ACTIVE / PAYMENT_FAILED / CANCELLED) и ещё 30 минут после; далее по вызову.

## 4. Проверка отсутствия незавершённой старой покупки (до входа)

Выполняется оператором **до** открытия create. Все шаги read-only, без финансовых команд.

1. **Viva Admin, список транзакций** (серверный admin token, не браузер):

       curl -sS -o /tmp/viva-residency.json -w '%{http_code}' \
         "https://api.vivacrm.ru/api/v1/transactions?clientIds=<clientId>&productIds=4037a3a3-e551-4f9a-a9db-1410e46b8635&dateFrom=<30 дней назад>&dateTo=<сегодня>&page=0&size=100&sort=createDate,desc" \
         -H "Authorization: Bearer $VIVA_ADMIN_TOKEN"

   Ожидается 200 и корректная страница <code>{content,totalPages,number,totalElements,last}</code>.
   Никакого <code>POST</code>. Если 401/403/5xx/таймаут — **стоп**: external guard тоже
   закроется, но пилот не начинаем. <code>clientId</code> — это Viva client id, не Keycloak
   <code>sub</code>; его берут read-only из Viva admin по телефону Алексея или из
   <code>GET /end-user/api/v1/iSkq6G/profile</code> после его входа. Не угадывать.
2. **Классификация списка**: нет <code>UNPAID/WAITING/PENDING/CREATED/UNKNOWN</code>; нет
   <code>PAID</code> без действующего резидентства. Допустимы только
   <code>CANCELLED/REFUNDED/FAILED/EXPIRED</code> или пустой список. Иначе — стоп и
   разбор старой операции.
3. **Gateway read**: после входа Алексея (и до открытия create) оператор читает
   <code>GET /lk/residency/orders?state=unresolved</code>; ожидается <code>count=0</code>,
   <code>externalCheck.state="OK"</code>, <code>openCount=0</code>,
   <code>paidAfterOrderCount=0</code>, <code>requiresReview=false</code>. Любое иное — стоп.
   Этот же read доказывает доступность Viva Admin: <code>externalCheck.state=UNAVAILABLE</code>
   или 503 <code>RESIDENCY_EXTERNAL_CHECK_UNAVAILABLE</code> — стоп без финансовой команды.
4. **Устройства**: Алексей закрывает старую страницу на всех устройствах; серверный список
   Viva остаётся авторитетным, локальный маркер не считается доказательством.
5. **Продукт/цена**: каталог отдаёт тот же продукт <code>4037a3a3…</code>, 30 дней;
   итоговая сумма фиксируется в журнале ровно как показана. Расхождение — стоп.

## 5. Критерии остановки

Останавливаемся (закрываем <code>CREATE_ENABLED=false</code>, не создаём новый ключ и не
платим второй раз), если:

| Событие | Признак |
| --- | --- |
| Старая операция | admin list содержит open/paid-unreflected, либо <code>externalCheck.requiresReview=true</code> |
| Create неоднозначен | 409/503/сеть/таймаут, ответ без orderId, либо два POST на один заказ |
| Сумма/продукт | отличается от показанной/подтверждённой |
| Две транзакции | по аккаунту/продукту появились две операции, одна из них не наша |
| Оплата не подтверждена | payment <code>UNKNOWN</code>, order <code>UNKNOWN_OUTCOME</code>, return без заказа |
| Review | <code>PAID_REQUIRES_REVIEW</code> / <code>EXTERNAL_PAYMENT_DETECTED</code> / <code>ACTIVATION_FAILED</code> |
| Нарушение условий | Алексей открыл старую страницу или оплатил вторую ссылку |

После остановки: чтение, <code>payment</code>, <code>reconcile</code>, <code>cancel</code>
начатого заказа продолжают работать; коллекция/индексы не удаляются; автоматических
refund/cancel нет.

## 6. Восстановление после потерянного ответа

1. Не повторять оплату, не создавать новый заказ и не менять Idempotency-Key.
2. Оператор читает <code>GET /orders/{orderId}</code> и
   <code>GET /orders/{orderId}/payment</code>; при необходимости —
   <code>POST /orders/{orderId}/reconcile</code> с тем же ключом/eventId.
3. Сверяет Viva Admin список: наша транзакция — по сохранённому
   <code>providerTransactionId</code>; любая вторая — review.
4. Если результат <code>UNKNOWN</code>: заказ остаётся <code>PENDING_PAYMENT</code> /
   payment <code>UNKNOWN</code>, слот удержан; повторять read/reconcile позже. Новый ключ
   не даёт права на повторный provider POST.
5. Если <code>PAID_REQUIRES_REVIEW</code>: клуб проверяет оплату; активация не выполняется
   автоматически.
6. Только подтверждённый терминальный отказ (<code>PAYMENT_FAILED</code>/<code>CANCELLED</code>)
   позволяет новый ключ — и только после явного подтверждения Алексея.

## 7. Массовое включение: технический вариант, закрывающий старый путь

Рекомендуемый вариант — **отдельный продукт для нового потока + скрытие старого продукта
в Viva**:

1. Завести новый продукт резидентства с теми же условиями (30 дней, 30%/50%, та же
   ценовая политика) и прописать его в <code>LK_RESIDENCY_LIFECYCLE_PRODUCT_ID</code> и в
   CUP (активация сверяет <code>providerProductId</code>).
2. На время раскатки скрыть/сделать недоступным старый продукт <code>4037a3a3…</code> для
   end-user (Viva admin: <code>showToUser=false</code>/снятие с продажи). Старый клиент при
   клике заново читает продукт с <code>cache:no-store</code> и падает до <code>POST</code>;
   это работает и для уже открытой старой страницы, и для второго устройства.
3. Сначала дренировать уже созданные старые транзакции по политике клуба (отмена
   неоплаченных/разбор оплаченных), затем включить новый продукт.
4. Defense in depth: если Viva поддерживает лимит «одна активная подписка на клиента/
   продукт» — включить его на уровне провайдера; это закрывает и нестандартные клиенты.

Почему это закрывает второе устройство и уже открытую страницу: старый клиент не хранит
цену, а перед созданием транзакции вызывает
<code>GET /end-user/api/v1/iSkq6G/products/subscriptions/4037a3a3…</code> с
<code>cache:no-store</code>; скрытый продукт даёт ошибку до <code>POST</code>.

Остаточные окна: страница, которая уже прошла чтение продукта и находится между чтением и
POST в момент скрытия; клиент, который жёстко зашил product id и не читает продукт; уже
созданные до скрытия транзакции. Поэтому нужен короткий переходный период с наблюдением и
дренажом. Fallback, если Viva не позволяет скрыть продукт: изменение опубликованного
старого клиента (не действует на уже загруженные страницы) или edge-прокси для
<code>/end-user/api/v1/{tenant}/transactions</code> с product-aware фильтром (сетевые
изменения, затрагивает другие продукты). Вариант с новым продуктом предпочтителен; он не
выполнен и требует Viva/CUP-настройки и отдельного согласования.

## 8. Порядок установки оператором (create закрыт)

Используется общий снимок композиции после проверки Кодексом:

| Объект | Идентификатор |
| --- | --- |
| LK1 slice после Codex | <code>lk1-slice.flow.json</code>, 54 узла, 3 <code>http in</code>, sha256 <code>ae9924dc78c4f2035cd3c5861c9291655c4800c0805ccc034bc2fbca100b213f</code> |
| Joint snapshot (LK1 + residency) | <code>joint-acceptance.flow.json</code>, 73 узла, 18 <code>http in</code>, sha256 <code>94202a84b8e1f253b415905a88c1f85881df4ded05d002bdee47a078e5864f0c</code> |
| Установочный пакет | 25 файлов, <code>SHA256SUMS</code> <code>3bd31d631a155b1c07e7301d4ebb45b055b1952a573477baa546500526a69c2b</code>, source <code>a7ca3270</code> |
| Новый browser artifact | <code>0a83dbc7…</code>, 2 976 424 B, <code>prepared-not-published</code> |
| Старый browser artifact | <code>fce60c89…</code>, 2 946 728 B, release <code>20261118T164240Z</code> / <code>27ea6a8c…</code> |

Снимок — это общий **slice** для композиции, а не полный <code>flows.json</code> 147. При
применении оператор снимает свежий полный preimage, проверяет его
<code>preimage-check.mjs</code> (5 678 узлов / 316 <code>http in</code>, нет lifecycle
id/route) и сохраняет hash; без этого установка не начинается.

Порядок:

1. **Preimage/custody.** Снять read-only полный export 147, сохранить в private custody,
   прогнать <code>preimage-check.mjs --expect-nodes 5678 --expect-http-in 316</code>.
   Сверить, что изменений в чужих узлах нет; кандидат — additive 19 узлов.
2. **Backups.** <code>flows.json</code>, оба env-файла, <code>package.json</code>,
   custom-node; sha256.
3. **Install closed.** Custom node + <code>mongodb@7.2.0</code>, пять индексов, import;
   env: <code>ENABLED=true</code>, **<code>CREATE_ENABLED=false</code>**,
   <code>CREATE_AUDIENCE=pilot</code>, <code>PILOT_USERS=[]</code>,
   <code>EXTERNAL_GUARD=true</code>, <code>IDENTITY_LOG=true</code>,
   <code>ENSURE_INDEXES=false</code>. Перезапуск; readback:
   - <code>OPTIONS /lk/residency/catalog</code> → 204;
   - <code>GET /catalog|status|orders?state=unresolved</code> с pilot token → 200;
   - <code>POST /orders</code> → **503 <code>RESIDENCY_ORDERS_DISABLED</code>** для всех;
   - старые <code>/lk/residency/passes</code>, summer-subscription и турнирные маршруты —
     без изменений.
4. **Viva Admin без финансовой команды.** Read-only list из раздела 4 (200, страница
   корректна, нет open/paid). Дополнительно <code>GET /orders?state=unresolved</code> →
   200, <code>externalCheck.state=OK</code>. Никаких <code>POST /orders</code>, booking или
   payment.
5. **Identity.** Алексей входит в ЛК1 и открывает **только**
   <code>https://padlhub.su/lk_new?buyResidency=lifecycle</code>; оператор читает в логе
   <code>{"event":"residency_lifecycle_identity",...,"identity":"iSkq6G:&lt;sub&gt;"}</code>.
   Вносит ровно это значение в <code>PILOT_USERS</code>, перезапускает с
   <code>IDENTITY_LOG=false</code>, <code>CREATE_ENABLED=false</code>. Синтетический
   fixture identity со стенда на 147 не переносится.
6. **Открытие только его аккаунту.** <code>CREATE_ENABLED=true</code>,
   <code>CREATE_AUDIENCE=pilot</code>, <code>PILOT_USERS=["iSkq6G:&lt;sub&gt;"]</code>;
   readback без покупки:
   - его <code>POST /orders</code> **без** <code>Idempotency-Key</code> → 400
     <code>RESIDENCY_IDEMPOTENCY_KEY_REQUIRED</code> (заказ и provider POST не создаются);
   - обычный аккаунт → 403;
   - старый вход <code>?buyResidency=1</code> не открывается Алексею; ссылка на него не
     выдаётся.
7. **Открыть тестовый вход** только после 3–6 и письменного подтверждения Алексея
   (раздел 1). Наблюдение — по разделу 3.

## 9. Hermes: browser artifacts и ожидаемая приёмка

| Артефакт | Идентификатор | Роль |
| --- | --- | --- |
| Старый опубликованный | <code>published-legacy-bundle.js</code>, sha256 <code>fce60c89044f95ef7ec9faf1d53267dfce87fcc996efa00dbacee87ab50485be</code>, 2 946 728 B, release <code>20261118T164240Z</code> / source <code>27ea6a8c1665789786b8a6c6fc9c657dc48483ed</code> | точный старый клиент |
| Новый пилотный | <code>frontend/bundle.js</code> из пакета, sha256 <code>0a83dbc72dc6c55549bab42ce597aa65089f9eca94f3577d803b04e018cbd59e</code>, 2 976 424 B, source <code>a7ca3270</code>, <code>prepared-not-published</code> | новый экран |
| Локальный synthetic bf3 (не production) | <code>residency-client-bf3/bundle.js</code>, sha256 <code>4c3fdca47c6442e9a07801450558de78e7b1600160bc74e343d2f59c8db02c72</code> | только для локальной сессии, не публиковать |

Ожидаемая приёмка (локальный стенд, синтетические Viva/CUP/Keycloak):

1. Старый артефакт: карточка резидентства рендерится; ровно один
   <code>POST /end-user/api/v1/iSkq6G/transactions</code>; ноль
   <code>/lk/residency/*</code>. При <code>CREATE_ENABLED=false</code> новый create → 503,
   старый POST всё равно создаёт транзакцию (остаточный риск).
2. Новый артефакт: страница пилота, каталог/статус 200; create без ключа → 400; обычный
   аккаунт → 403; один POST/один заказ; оплата + reconcile → ACTIVE;
   <code>CREATE_ENABLED=false</code> → create 503, read/reconcile 200; гонка → нет второй
   ссылки, payment <code>UNKNOWN</code>, <code>UNKNOWN_OUTCOME</code>.
3. Браузерный контракт: seed <code>localStorage.padlhub_auth_token_v1</code> =
   <code>{"token":"&lt;JWT&gt;","expiresAt":&lt;future&gt;}</code>, payload JWT
   <code>sub</code>, <code>phone</code> (например <code>+15550000000</code>, не PII),
   <code>azp:"widget"</code>, <code>tenant_key:"iSkq6G"</code>; старый клиент использует
   <code>?buyResidency=1</code>, кнопка <code>[data-ph-buy="residency"]</code>; новый —
   <code>?buyResidency=lifecycle</code>. Перехватывать <code>api.vivacrm.ru</code> и
   <code>kc.vivacrm.ru</code> на fixture, <code>/lk/residency/*</code> — на Node-RED.
   Синтетический OIDC issuer старого bootstrap не подходит; нужен именно этот
   storage-контракт. Все внешние вызовы — только fixture, реальных Viva/CUP/Keycloak нет.
4. Общий снимок для композиции — <code>joint-acceptance.flow.json</code> (73/18,
   <code>94202a84…</code>); полный 147 preimage — отдельно и только read-only.

## 10. Оценка времени

При готовом доступе (SSH/preimage, admin token, подтверждённый <code>sub</code>) и
доступности Алексея:

| Шаг | Время |
| --- | --- |
| Preimage, custody, preimage-check, backups | 1–2 ч |
| Install closed (node/indexes/import/env), readback | 1–2 ч |
| Viva Admin read-only + gateway readback | 20–30 мин |
| Вход Алексея, чтение identity, allowlist, restart | 15–30 мин + 10 мин Алексея |
| Открытие только его аккаунту (400/403), тестовый вход | 20–30 мин |
| **Итого до открытия тестового входа** | **3–5 часов** в один рабочий день |

Реальная покупка — отдельно, после установки; цена читается каталогом в момент покупки.

## 11. Финальный чек-лист оператора

- [ ] Свежий полный preimage 147, hash сохранён, <code>preimage-check</code> pass.
- [ ] Backups и sha256.
- [ ] Install с <code>CREATE_ENABLED=false</code>; readback: OPTIONS 204, reads 200, create 503.
- [ ] Viva Admin read-only 200, нет open/paid; gateway <code>externalCheck.state=OK</code>.
- [ ] Алексей подтвердил условия (раздел 1), старая страница закрыта на всех устройствах.
- [ ] Identity из лога, <code>PILOT_USERS</code> только его, <code>IDENTITY_LOG=false</code>.
- [ ] Pilot create без ключа → 400; обычный → 403; ссылка на старый вход не выдаётся.
- [ ] Наблюдение оператора включено; журнал заказа открыт.
- [ ] Стоп-сигналы раздела 5 известны; восстановление раздела 6 отработано.
- [ ] Реальная покупка не начата до отдельного согласования суммы.

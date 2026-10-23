# «Дружба.Патриоты»: паритет с обычной «Дружбой»

## Результат и границы

Владелец: LK1 backend. Аудитория: владельцы Viva-продукта
`37ab3713-4431-4815-96ba-d7ece76a9241` («Дружба.Патриоты»).
Решение владельца от 2026-10-21: механика должна быть такой же, как у обычной
«Дружбы». Подготовка этого кандидата не выполняет merge, import/restart,
изменение globals, записи, покупки или публикацию Tilda.

Новый композитор `scripts/patch_live_lk1_patriots_friendship_parity.mjs` копирует
правило **из установленного flow**, заменяя только `productId`:

| Поле | Установленное правило обычной «Дружбы» |
| --- | --- |
| `planKey` | `friendship` |
| `enforceFrom` | `2026-09-01` |
| `maxActiveBookings` | 8 |
| `freeGameMinutesPerDay` | 60 |
| `gameOverageDiscountPercent` | 30 |
| `groupTrainingDiscountPercent` | 50 |
| `tournamentDiscountPercent` | 50 |

Сохраняется учёт по выбранному экземпляру подписки. Бесплатные минуты относятся
к московскому дню; после их использования и при восьми активных записях новая
игра оплачивается со скидкой 30% без списания посещения. Порог 8 не запрещает
новую платную запись. Тренировки и турниры получают 50% без нового бесплатного
визита: обычная «Дружба» не входит в `LK1_FREE_FIRST_EVENT_PRODUCTS`, и Патриоты
также не добавляются в эту таблицу. В legacy-когорте сохраняется `shared_day`;
неизвестная дата покупки и неподтверждённые владение/срок/заморозка дают отказ.
Денежное событие требует ACTIVE-подписку по действующему event-preview контракту,
как у обычной «Дружбы»; новая политика первой активации здесь не вводится.

Прежний `patch_live_lk1_patriots_friendship.mjs` привязан к историческому flow
и отдельному `planKey: patriots`. Он не используется в этом выпуске. Нельзя
собрать новый кандидат подстановкой старых generic gateway/evaluator sources:
они несут другие поколения. Новый focused-композитор сохраняет установленный
evaluator и все десять действующих plan rules.

## Точный кандидат

Read-only preimage от 2026-10-21: 4 839 узлов, SHA256
`53b4dfc545896e702544427ff8752c020b0de5f1fd35027ec7d8f8dabcda1655`.
Меняются только три поля двух существующих узлов:

- `lk_subscription_booking_router_20260804`: `initialize`, `func`;
- `lk_subscription_price_preview_20260908_router`: `func`.

В обоих роутерах UUID-only Патриоты распознаются как `friendship`, точные пары
`6181/2349`, `6306/2349`, `6307/2349` — как игра, турнир, тренировка.
Предыдущие exact-ID правила и остальные corporate-направления сохраняются.
В preview включается уже имеющийся product-bound `supportsPatriotsGameScope`:
только серверное событие `6181/2349` либо `4588/1613` может выбрать игровую
область Патриотов. Чужая пара не получает льготу через этот игровой путь.

В `initialize` добавляется одиннадцатое правило. Writer допускает точный prior,
своё итоговое значение и пустой контекст после restart; чужое значение не
перезаписывает. Полный flow digest и три function preimages обязательны.
Exact-graph контракт не допускает изменения HTTP inputs, wires, evaluator,
платёжных функций, новых узлов или чужих полей. Rollback принимает только точный
кандидат и возвращает точные исходные bytes, не пересобранный старый flow.

Затрагиваемые существующие endpoints: `POST /lk/subscription-bookings`,
`POST /lk/subscriptions/game-price-preview`. Новых HTTP endpoints и tracked
flow/import/export JSON нет. CLI пишет candidate/contract/plan-rules только
в новый внешний каталог 0700, файлы 0600; перезапись output запрещена.

## Проверки

```sh
npm run nodered:modular:pull-147 -- /absolute/new/private/workspace
node scripts/verify_nodered_source_origin.mjs --workspace /absolute/new/private/workspace
PATRIOTS_FRIENDSHIP_LIVE_FLOW=/absolute/new/private/workspace/input/source.flow.json npm run test:lk1-patriots-friendship-parity
node scripts/patch_live_lk1_patriots_friendship_parity.mjs /absolute/new/private/workspace/input/source.flow.json /absolute/new/private/output
```

Тесты проверяют копирование правила/даты, идемпотентность, чужой prior,
exact-ID/category маршруты и сохранение чужих продуктов, неизменный evaluator
на границах 60/90/120 минут и 0/7/8 активных записей, реальные ветки preview
для корпоративной игры и денежной скидки 5278, отрицательные lifecycle/identity
проверки, exact-field diff, paired rollback и приватность CLI output.
В CI проверки с боевым snapshot пропускаются: приватные flow bytes не публикуются.
Перед реальным apply нужен успешный local-прогон с точным проверенным snapshot.

## Отдельные блокеры страницы

Read-only Viva-проверка 2026-10-21 на 120 дней обнаружила:

- одна игра 6181: два разовых продукта по 2 000 ₽;
- одна тренировка 6307: пустой список разовых тарифов;
- 78 событий 5278: один разовый тариф по 5 500 ₽, целевая цена со скидкой 2 750 ₽;
- будущих турниров 6306 нет.

Этот серверный кандидат не выбирает тариф наугад. Карточки Tilda всё ещё
направляют все категории в `group-schedule.js` / `GROUP_TRAINING`, поэтому
корпоративной игре и обоим видам турниров нужен соответствующий путь записи.
Для всех событий 5278 нельзя полагаться на наличие `/tournaments/{id}` без проверки.
Отсутствие 5278/839 в visit scope продукта Viva сохраняется: речь о денежной скидке,
а не о списании посещения. Публичный `PH_PATRIOTS_ENTITLEMENTS_READY=true`
сам по себе не подтверждает готовность этих путей.

## Активация и восстановление

Применение требует отдельного разрешения точного пакета на
`lk-primary-147:/root/.node-red/flows.json` с одним штатным restart и guarded
recovery. Перед ним проверить fresh preimage, pushed source/CI и read-only
review, а затем exact-graph контракт, lock/lease и backup по
`NODERED_MODULAR_WORKFLOW.md`. Все три поля устанавливаются одним графом.

После apply: digest кандидата, PM2 online/restart identity, отсутствие ошибок
writer и runtime readback одиннадцати правил через существующий авторизованный
read-only context API или подтверждённые quote-проверки. Чтение initializer
с диска не доказывает in-memory globals. Десять прежних правил должны совпасть.
Реальная запись/оплата требует отдельно согласованного сценария.

Стоп-сигналы: drift/foreign lease, ошибка writer, несоответствие policy или quote,
потеря доступности. До apply остановиться; после apply использовать только
штатный guarded rollback своего exact backup. Не удалять lease и не возвращать
старое общее поколение. Rollback кода не отменяет реальные брони и платежи.

Предпосылка восстановления: globals должны храниться только в памяти, а rollback
должен выполнять штатный restart. Read-only проверка 147 от 2026-10-21 показала,
что `contextStorage` в settings закомментирован (default memory). Возврат старого
initializer через hot import с сохранёнными одиннадцатью правилами отвергается
его prior guard; это отдельно проверяет тест. Перед apply повторно подтвердить
memory-only context. При persistent context пакет не применять: потребуется
отдельный проверенный обратный переход правил, а не обход guard.

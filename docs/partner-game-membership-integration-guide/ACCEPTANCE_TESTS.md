# Приёмочные тесты перед go-live

Чек-лист для тестового контура. Каждый пункт — конкретное ожидаемое поведение, а не
описание «в целом». Колонка «Проверено у нас» отмечает, наблюдалось ли это поведение
на нашем рабочем контуре вживую (`да`), либо следует из контракта и проверяется на
вашей стороне (`контракт`).

Тестовые значения подставьте свои: `<HOST>`, `<GAME_ID>`, `<MEMBERSHIP_ID>`. Реальные
значения приходят вместе с доступами.

## A. Офлайн, без сети

| № | Действие | Ожидаемо | Проверено у нас |
| --- | --- | --- | --- |
| A1 | `node contract-selftest.mjs --self-test` в офлайн-комплекте | `OFFLINE_CONTRACT_VECTORS_PASS vectors=5 network=NOT_USED live_security=NOT_TESTED` | контракт |
| A2 | Свой подписывающий код на публичном vector `POST_BASE` | `v2=JclK7-2hTze2KrNOPMuK0UdEO5DO2T5v6geJxxjRCAo` | да |
| A3 | Повтор `POST_RETRY`: тот же `Idempotency-Key`, тот же body, новые timestamp/nonce/correlation | Подпись меняется, `Idempotency-Key` сохраняется | контракт |

## B. Транспорт и ingress

| № | Действие | Ожидаемо | Проверено у нас |
| --- | --- | --- | --- |
| B1 | Запрос без клиентского сертификата | Отказ до бизнес-логики (`400`, рукопожатие/`403`) | да |
| B2 | Запрос с чужим `Host`/SNI | `421` | да |
| B3 | TLS ниже 1.2 | Отказ | да |
| B4 | Маршрут вне трёх выданных | `404 ROUTE_NOT_FOUND` | да |
| B5 | Запрос с IP вне allowlist | `403` от ingress | да |
| B6 | `Content-Type: application/json; charset=utf-8` | `400 RAW_CONTENT_TYPE_INVALID` | да |
| B7 | Ответ содержит `Cache-Control: no-store`, без CORS-заголовков | да | да |

## C. Основной сценарий

| № | Действие | Ожидаемо | Проверено у нас |
| --- | --- | --- | --- |
| C1 | `POST /open-games/<GAME_ID>/members` с корректной подписью | `201`, `membership.state=ACTIVE`, `paymentStatus=PAID`, `settlementSource=EXTERNAL_PARTNER` | да |
| C2 | `GET /operations/<OPERATION_ID>` из C1 | `200`, `operation.state=COMPLETED`, `error=null` | да |
| C3 | Участник появился в ЛК/ЦУП, в Viva создан booking на технического клиента с `paymentType=ON_PLACE` | да | да |
| C4 | `DELETE /open-games/<GAME_ID>/members/<MEMBERSHIP_ID>` с телом ровно `{}` | `200`, `membership.state=REMOVED` | да |
| C5 | `GET` операции удаления | `200`, `state=COMPLETED` | да |
| C6 | Booking в Viva отменён | да | да |
| C7 | Второй участник на ту же игру | `201`, отдельный booking; участники не конфликтуют | да |

## D. Идемпотентность и replay

| № | Действие | Ожидаемо | Проверено у нас |
| --- | --- | --- | --- |
| D1 | Повторить C1 с тем же `Idempotency-Key`, тем же телом, новым proof | `200`, тот же `operationId` и `membershipId`, второго booking нет | контракт |
| D2 | Тот же `Idempotency-Key`, но другое тело | `409 IDEMPOTENCY_CONFLICT` | контракт |
| D3 | Дословно переслать тот же wire-запрос (тот же nonce) | `409 REQUEST_REPLAY_DETECTED` | контракт |
| D4 | Повторить `DELETE` | Тот же результат, состояние `REMOVED` | контракт |
| D5 | Оборвать соединение и повторить команду с прежним `Idempotency-Key` | Результат не дублируется | контракт |

## E. Доступ

| № | Действие | Ожидаемо | Проверено у нас |
| --- | --- | --- | --- |
| E1 | Игра вне allowlist | `403 GAME_ACCESS_DENIED` | контракт |
| E2 | Станция вне allowlist | `403 STATION_ACCESS_DENIED` | контракт |
| E3 | `DELETE` чужого membership | `403 MEMBERSHIP_NOT_OWNED` | контракт |
| E4 | Неверный scope | `403 SCOPE_DENIED` | контракт |
| E5 | Отключённый клиент или ключ | `403 CLIENT_DISABLED` / `401 INVALID_SIGNATURE` | контракт |

## F. Валидация

| № | Действие | Ожидаемо | Проверено у нас |
| --- | --- | --- | --- |
| F1 | Неизвестное поле в теле | `400 UNKNOWN_REQUEST_FIELD` | контракт |
| F2 | Ошибка в подписи | `401 INVALID_SIGNATURE` | контракт |
| F3 | `X-PadlHub-Audience` другого окружения | `401 INVALID_AUDIENCE` | контракт |
| F4 | Timestamp вне окна ±90 с | `401 INVALID_TIMESTAMP` / `REQUEST_EXPIRED` | контракт |
| F5 | `Idempotency-Key` не lowercase UUID | `400 INVALID_IDEMPOTENCY_KEY` | контракт |
| F6 | `payment.reference` уже использован | `409 PAYMENT_REFERENCE_ALREADY_CLAIMED` | контракт |
| F7 | Игрок уже активен в игре | `409 MEMBER_ALREADY_ACTIVE` | контракт |
| F8 | Дубль critical-заголовка | `400 RAW_HEADER_DUPLICATE` | да |
| F9 | Дубль ключа в JSON | `400 RAW_JSON_DUPLICATE_KEY` | да |

## G. Лимиты и неоднозначные исходы

| № | Действие | Ожидаемо | Проверено у нас |
| --- | --- | --- | --- |
| G1 | Превысить 2 rps на клиента | `429` | контракт |
| G2 | Тело больше 16 384 байт | `413` или `400 RAW_BODY_SIZE` | контракт |
| G3 | Искусственный таймаут после отправки | `202` и `state=UNKNOWN`; далее только `GET` | да |
| G4 | `202` обработан по [IDEMPOTENCY.md](IDEMPOTENCY.md): без слепого provider retry и без автоматического `DELETE` | да | контракт |

## H. Подпись приёмки

- [ ] Все пункты A–G пройдены на тестовом контуре.
- [ ] Расхождение по любому пункту зафиксировано письменно и закрыто.
- [ ] Секреты и приватные ключи лежат в защищённом хранилище; test и production
      разделены.
- [ ] Логи не содержат подпись, секрет, nonce, тело, `displayName`,
      `payment.reference`.
- [ ] Определено поведение при отзыве доступа и порядок эскалации.
- [ ] Чек-лист go-live из [ONBOARDING.md](ONBOARDING.md) подписан обеими сторонами.

Пункты с пометкой `да` уже наблюдались на нашем контуре на тестовой игре; они служат
эталоном ожидаемых значений. Пункты `контракт` проверяются на вашей стороне и
подтверждаются протоколом приёмки.

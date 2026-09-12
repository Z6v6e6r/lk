# Серверная авторизация Viva для Partner API

Рабочая схема заведения клиента и прав для передачи администратору Viva/Keycloak:
[VIVA_CLIENT_SETUP](PARTNER_GAME_MEMBERSHIP_VIVA_CLIENT_SETUP.md).

Статус: локальная реализация и автоматические проверки; **не deployed, не live grant,
не activation**. Партнёр получает только контракт Partner API и собственный доступ.
Учётная запись Viva, её права, настройка сервиса и проверка результата — зона PadlHub;
от партнёра не требуются ответы или согласование этой реализации.

## Настройки

Все имена ниже относятся к окружению серверного процесса. Значения секретов нельзя
передавать через Partner HTTP, включать в packet, Git, stdout, audit или public kit.
Этот этап не создаёт EnvironmentFile, не меняет credentials и не открывает egress.

| Настройка | Контракт |
| --- | --- |
| `LK_PARTNER_GAME_API_VIVA_TOKEN_SOURCE` | `password-grant` для standalone sidecar; неизвестное значение — закрытый отказ |
| `LK_PARTNER_GAME_API_VIVA_SERVICE_CLIENT_ID` | Обязательный OAuth client ID, 1–128 символов `A-Z a-z 0-9 . _ : -`; default отсутствует |
| `LK_PARTNER_GAME_API_VIVA_SERVICE_USERNAME` | Обязательное имя сервисной учётной записи, не whitespace-only, до 1024 UTF-8 bytes |
| `LK_PARTNER_GAME_API_VIVA_SERVICE_PASSWORD` | Обязательный пароль до 4096 UTF-8 bytes; пробелы сохраняются |

Отсутствующий/пустой selector или `global-context` сохраняет прежний источник
`vivacrm_access_token` / `vivacrm_token_expires_at`. Это только совместимость:
новый memory context отдельного sidecar сам не наполняется. В режиме password grant
нет fallback к global context или общим `VIVA_SERVICE_*` переменным.
Selector фиксируется при создании runtime; scoped credentials перечитываются при
вызове resolver и перед сохранением результата. Правка EnvironmentFile сама по себе
не меняет окружение уже запущенного процесса: требуется отдельно разрешённое
управляемое обновление сервиса.

## Получение и срок жизни

Используется существующий repository service-auth контракт
`scripts/nodered_games_nodes/fn_viva_game_projection_sync_token.js`:
`POST https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token`,
`application/x-www-form-urlencoded`, `grant_type=password`, `client_id`, `username`,
`password`. Адрес/grant фиксированы кодом, redirect запрещён. Это повторный password
grant при истечении, **не OAuth refresh_token flow**. Наличие исходного контракта не
доказывает актуальные права сервисной учётной записи в Viva.

Resolver создаётся только для real Viva provider, но не получает credentials/token,
пока закрыт хотя бы один provider readiness gate. Один resolver допускает один
grant одновременно; остальные вызовы ждут ту же promise. Между процессами кэш и
single-flight не разделяются.

- Ответ: только HTTP 200, без redirect или смены final URL. Запрашивается
  `Accept-Encoding: identity`; nonidentity encoding отклоняется до чтения.
- Лимит всего ответа — 65 536 bytes, строгий UTF-8 и точный Content-Length, если
  присутствует. Весь запрос и чтение ограничены 5s; проверяется также elapsed
  monotonic deadline, а не только срабатывание таймера. Reader отменяется при отказе.
- Требуются `access_token`, `token_type=Bearer` (без учёта регистра), целый
  `expires_in` от 31 до 86400 секунд. Нет предположения о TTL при отсутствующем поле.
- Кэш живёт до `начало grant + expires_in - 30 секунд` по monotonic clock.
  Время ответа входит в срок; cache hit не продлевает его. Невалидные/обратные часы
  закрывают доступ. Токен и fingerprint credentials хранятся только в памяти.
- Смена/удаление credentials сбрасывает кэш; смена во время grant не позволяет
  принять старый результат. Pending запрос отменяется при следующем вызове с
  изменёнными credentials; завершение grant также повторно проверяет их.
- Ошибочный grant даёт cooldown 1s для тех же credentials; без фоновых/бесконечных
  повторов. Node close очищает кэш и прерывает pending; поздний body отменяется.
- Ошибка — фиксированная `VIVA_SERVICE_TOKEN_UNAVAILABLE`, HTTP 503,
  `expose=false`, `ambiguous=false`. Причина upstream и credential values не выходят
  в исключение. Существующий API сохраняет redacted rejected-ingress audit.

Кэш не отзывает уже выданный access token в Viva. Экстренное отключение Partner API
и права/сессии сервисной учётной записи управляются отдельной эксплуатационной
процедурой. После provider 401 нет автоматического auth/retry booking: старая
мутация не повторяется. До TTL/управляемого обновления такой токен может вновь
получить 401; это остаточное ограничение, а не доказательство revocation support.

## Доказательства и оставшиеся шаги

`partnerGameMembershipVivaProvider.test.mjs` покрывает grant, encoding, строгий
ответ, deadline, cache, concurrency, rotation/removal, close и отсутствие mutation
retry. `partnerGameMembershipApi.test.mjs` проверяет server env wiring, отсутствие
fallback, legacy-совместимость, disabled/ownership/replay инварианты.
Тесты используют явно синтетические значения и подставленный fetch; боевой сервис
авторизации и операции Viva не вызываются.

Схема: [Security architecture, страница Viva token](assets/partner-game-membership-security.drawio).

Изменение двух custom-node source файлов инвалидирует прежнюю exact runtime
closure. Исторические audit/functional/guarded receipts остаются неизменными.
Release validator должен отказать до фактического refresh; менять ожидаемые хеши
только ради зелёного результата запрещено. Перед выпуском нужны:

1. Bound startup и production Nginx verifier вместо текущих заглушек/default-off.
2. Минимальный server-owned credential/egress contract для exact Mongo/Viva целей;
   live установка и изменение ACL — отдельный разрешённый переход.
3. Новый exact-source runtime/guarded/packet proof после завершения source diff.
4. Разрешённый live readback/token grant и тест на выбранной игре, затем выдача
   партнёру проверенного рабочего комплекта через пользователя.

Отложенная пользователем native Nginx application rehearsal остаётся
`DEFERRED_BY_USER / NOT_RUN`. Она не заменяется unit-тестами token resolver.

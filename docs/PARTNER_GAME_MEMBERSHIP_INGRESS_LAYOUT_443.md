# Partner API: выбор схемы ingress — общий 443

Статус: **решение принято владельцем; живые операции не выполнялись**.

## Решение

Схема размещения ingress для Partner Game Membership API — **общий 443** (существующий
TLS-listener), а не изолированный `8443` и не выделенный IP.

Основание: API публикуется как отдельный `server`-блок с `server_name`/SNI-пиннингом,
поэтому партнёрский URL не содержит порта и не требует ни нового IP, ни изменения DNS.
Вариант `8443` отклонён (порт в URL и отдельная проверка доступности), выделенный IP —
из-за стоимости и отдельной привязки DNS/PKI.

Это решение меняет общие условия обработки соединений на listener 443, поэтому
зафиксировано как влияние, требующее проверки остальных сайтов (см. ниже).

## Что уже даёт overlay

Генератор `scripts/partner_game_membership_nginx_shared_overlay.mjs` формирует
`server`-блок для 443 с собственными, не наследуемыми от других сайтов условиями:

- `listen 443 ssl` и `listen [::]:443 ssl`, `server_name <exactHost>`;
- `ssl_protocols TLSv1.2 TLSv1.3`, `ssl_verify_client on`, `ssl_verify_depth 1`;
- отказ `421`, если SNI или `Host` не совпали с точным хостом;
- отказ `403`, если фактический `$ssl_protocol` вне `TLSv1.2/1.3`;
- отказ `403`, если клиентский сертификат не равен утверждённому публичному leaf;
- allowlist маршрутов ровно на три пути `/lk/integrations/v1/...`;
- allowlist IP-источников, `deny all` по умолчанию;
- `limit_req` 2 rps (burst 10) и `limit_conn` 4 на клиента, 5 rps (burst 20) и 8 на
  источник; `limit_req_status/limit_conn_status 429`;
- лимиты тела и заголовков (`client_max_body_size 16k`, `client_header_buffer_size 2k`,
  `large_client_header_buffers 7 2k`, таймауты 5/5/15 s);
- `Cache-Control: no-store`, `gzip off`, `server_tokens off`;
- `proxy_pass http://127.0.0.1:18894` с очисткой `Forwarded`/`X-Forwarded-*`;
- audit-log без тела и security-заголовков.

Ни один из этих параметров не наследуется от общего профиля: блок самодостаточен.

## Что блокирует применение

1. **Утрачен актуальный read-only снимок профиля хоста.** Приватные receipts прошлого
   шага (`/private/tmp/partner-nginx-step1-20260910/`) больше не существуют; без
   свежего снимка нельзя построить точный shared-default/TLS/header/listener diff.
2. **Корневой `ssl_protocols`** (`/etc/nginx/nginx.conf:33`, исторически
   `TLSv1 TLSv1.1 TLSv1.2 TLSv1.3`) не соответствует поддерживаемому профилю checker;
   фактическая доступность TLS 1.0/1.1 не доказана (первый default-кандидат
   переопределяет TLS). Требуется решение: не ослаблять наш блок и не менять общий
   профиль без влияния на остальные сайты.
3. **Пять header-контролов** (`client_header_buffer_size`,
   `large_client_header_buffers`, `client_header_timeout`, `ignore_invalid_headers`,
   `underscores_in_headers`) у первого default-кандидата не доказаны
   (`MISSING_OR_DUPLICATE`).
4. **Параметры `listen`** общего профиля не совпадают с поддерживаемым профилем.
5. `verifyPartnerProductionIngress()` по-прежнему безусловно возвращает
   `UNSUPPORTED_INGRESS_ADAPTER`: живой verifier не реализован.

## Порядок живых операций (каждая — отдельное разрешение)

1. Свежий **read-only** снимок конфигурации 147 в новый приватный workspace
   (`nginx:modular`-подобный pull не используется; только scoped read) с проверкой
   root ownership и identity до/после чтения.
2. Построение точного diff: shared-default, TLS, header, listener, влияние на
   остальные 14 (актуальное число) `server`-блоков.
3. `nginx -t` на копии конфигурации с подключённым overlay (без записи в живой файл).
4. Атомарная установка overlay-файла + `include`, preimage сохранён для rollback.
5. `nginx -t` на живом дереве.
6. `reload` (не restart), затем проверки: TLS 1.2/1.3, отказ 1.0/1.1, `421` при чужом
   SNI/Host, `403` без mTLS, `404` вне allowlist, `429` на rate limit, отсутствие CORS,
   `no-store`.
7. Проверка, что остальные сайты на 443 не изменили поведение (выборочные probes).
8. Только после этого — установка sidecar `127.0.0.1:18894`, keyring, mTLS-сертификаты,
   Mongo, Viva-техклиент и отдельная активация канареечного клиента.

Rollback: вернуть preimage и убрать `include`, затем `nginx -t` и `reload`. Автоматическая
обратная provider-мутация запрещена.

## Состояние

- Локальные проверки shared-adapter/overlay/candidate/generation: **338/338 PASS**.
- **Канареечный 443 поднят 2026-09-11** (см. журнал ниже): overlay установлен и
  активирован, probes пройдены, остальные сайты не затронуты.
- Sidecar `127.0.0.1:18894` ещё не установлен, поэтому валидный партнёрский запрос
  корректно получает `502 Bad Gateway`. Keyring, Mongo, Viva и активация — впереди.

## Снимок 147 от 2026-09-11 (read-only)

`3170594-cd19972`, nginx 1.24.0 (Ubuntu), приватные receipts вне Git
(`/private/tmp/partner-nginx-443-20260911/`). Сертификаты и ключи не читались.

Корневой `http{}` (`/etc/nginx/nginx.conf`):

```text
worker_processes auto;
ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers on;
gzip on;
# server_tokens off;  (закомментирован, значит default on)
```

`include /etc/nginx/conf.d/*.conf;` идёт до `include /etc/nginx/sites-enabled/*;`.

Наблюдения, важные для shared 443:

- **`default_server` не задан нигде.** Первый по порядку включения `server`-блок на 443
  становится неявным default. Порядок: `kozlovatv.ru`, `moscowpadelday.ru`,
  `padlhub.su`, `score-padlhub-disabled.conf`, `zver.tw1.ru`. Наш блок не претендует
  на default, поэтому ничего не перехватывает.
- **В `sites-enabled` лежат две не-dot копии `padlhub.su`** — `padlhub.su.backup-padel-day-…`
  и `padlhub.su.pre-547ee2e-…`. Обе включаются glob'ом и дублируют
  `server_name padlhub.su www.padlhub.su` (nginx при этом предупреждает о конфликте имён).
  Это существующая проблема гигиены каталога, не наша; трогать в этом этапе нельзя,
  но при проверке «остальных сайтов» её надо учесть как baseline.
- Другие 443-блоки используют `listen 443 ssl http2` и подключают
  `/etc/letsencrypt/options-ssl-nginx.conf` (`ssl_protocols TLSv1.2 TLSv1.3;`,
  `ssl_prefer_server_ciphers off;`, Mozilla-список ciphers). Наш блок — HTTP/1.1
  (`listen 443 ssl;` без `http2`) и задаёт свои TLS-параметры.
- `conf.d/*.conf` объявляют только `map`, `log_format` и два `limit_req_zone`
  (`lk_subscription_*`, `lk_tournament_*`) на уровне `http{}`. Коллизий с нашими
  `pgm_v02_*` зонами нет.
- Корневой `ssl_protocols` содержит TLSv1/1.1, но это не влияет на наш хост: блок
  объявляет `ssl_protocols TLSv1.2 TLSv1.3` сам и дополнительно отдаёт `403`, если
  фактический `$ssl_protocol` ниже 1.2.

По итогам снимка генератор overlay сделан самодостаточным: добавлены явные
`ssl_prefer_server_ciphers off`, `ssl_ciphers` (тот же Mozilla-список, что уже
используется на хосте), `ignore_invalid_headers on` и `underscores_in_headers off`,
чтобы блок не зависел от общего профиля.

### Что осталось до применения

0. ~~Провизия имени и сертификата.~~ **Выполнено 2026-09-11** — см. журнал ниже.
1. `nginx -t` на копии дерева с подключённым overlay (без записи в живой файл).
2. Атомарная установка overlay + `include`, preimage сохранён.
3. `nginx -t` на живом дереве, затем `reload`.
4. Probes: TLS 1.2/1.3, отказ 1.0/1.1, `421` при чужом SNI/Host, `403` без mTLS,
   `404` вне allowlist, `429`, `no-store`, отсутствие CORS.
5. Выборочная проверка остальных сайтов на 443 (включая baseline-конфликт
   дублированных `padlhub.su`).
6. Реализовать `verifyPartnerProductionIngress()` — сейчас `UNSUPPORTED_INGRESS_ADAPTER`.

## Журнал: DNS и сертификат (2026-09-11)

**DNS.** Владелец создал `A partner-api.padlhub.su → 147.45.103.3` (TTL 300) в панели
Timeweb. Зона `padlhub.su` обслуживается `ns1/ns2.timeweb.ru`, `ns3/ns4.timeweb.org`;
на хосте нет ни API-доступа к Timeweb, ни TSIG-ключей, поэтому запись создавал владелец.

**Распространение.** Первый выпуск сертификата упал: Let's Encrypt получил
`NXDOMAIN looking up A for partner-api.padlhub.su`. При этом `ns1`, `ns2` и `ns4`
уже отдавали адрес, а `ns3.timeweb.org` — нет (пустой ответ), и SOA-серии расходились
(33 против 35). Через ~4 минуты `ns3` догнал, все четыре NS стали согласованы, и
повторный выпуск прошёл. Первый неудачный challenge не изменил конфигурацию.

**Сертификат.** `certbot certonly --nginx -d partner-api.padlhub.su` (certbot 2.9.0,
production-аккаунт): `subject=CN=partner-api.padlhub.su`, `issuer=Let's Encrypt YE2`,
ECDSA, SAN только этот hostname, действует до 2026-12-10. Renewal-конфиг:
`authenticator=nginx`, `installer=nginx`, `key_type=ecdsa`.

Проверено после выпуска:

- хеши `nginx.conf`, `sites-enabled/*`, `conf.d/*` **совпали с pre-image**;
- постоянного vhost `partner-api.padlhub.su` certbot **не оставил** (`certonly`, без
  installer-изменений);
- `nginx -t` успешен, `systemctl is-active nginx` = `active`, версия 1.24.0.

Сертификаты и ключи не читались и в репозиторий не копировались; приватный pre/post
image — в `/private/tmp/partner-nginx-443-20260911/`.

**Следующая зависимость.** Для боевого клиента партнёра нужен его CSR: overlay пинит
именно его leaf и CA. Чтобы не ждать, канареечный контур поднят с временным клиентским
сертификатом, выпущенным нами (см. следующий раздел); при получении CSR overlay
перегенерируется и заменяется.

## Журнал: канареечный 443 поднят (2026-09-11)

Решение владельца — вариант 2: выпустить временный клиентский сертификат самим, чтобы
поднять канареечный 443 без ожидания партнёра, а при получении его CSR перегенерировать
overlay и ротировать.

Сделано:

- сгенерирован временный клиентский CA (`CN=PadlHub Partner Canary Client CA`,
  CA:TRUE, keyCertSign) и leaf (`CN=padlhub-canary-client`, CA:FALSE,
  extendedKeyUsage=clientAuth), ECDSA P-256; приватные части — только в
  `/private/tmp/partner-canary-mtls-20260911/` (0600), в Git не попадают;
- overlay сгенерирован генератором: `state=LOCAL_NGINX_SHARED_OVERLAY_DRAFT_NOT_DEPLOYABLE`,
  `configSha256=5133c29724485a5d9e8b0c7e9646909db60b0eb214d772858cc5e5b4a3db3f5d`,
  allowlist источника — временно `194.71.130.27` (IP этой машины);
- `/etc/nginx/partner-game-membership-api-v02/`: `server-chain.pem` и `server.key` —
  симлинки на `/etc/letsencrypt/live/partner-api.padlhub.su/` (приватный ключ не
  дублируется), `client-ca.pem` — публичный CA канарейки;
- `/etc/nginx/conf.d/partner-game-membership-api-v02.conf` — overlay; `nginx -t`
  успешен, затем `systemctl reload nginx`; preimage конфигурации сохранён.

Матрица проб:

| Проба | Результат |
| --- | --- |
| без клиентского сертификата | `400` |
| чужой `Host` | `421` |
| чужой `X-PadlHub-Client-Id` | `403` |
| маршрут вне allowlist | `404` |
| валидный маршрут (sidecar не поднят) | `502`, `Cache-Control: no-store`, без CORS |
| TLS 1.1 | отказ |
| `padlhub.su` / `score.padlhub.su` / `kozlovatv.ru` | `302` / `410` / `200` — без изменений |

Остаточные риски этого шага:

- allowlist источника и пин клиентского leaf — **временные**; перед передачей партнёру
  их надо заменить на его адреса и сертификат, overlay перегенерировать;
- приватный ключ канареечного клиента хранится на этой машине и должен быть уничтожен
  или ротирован после замены;
- наш блок объявляет `error_log /dev/null crit`, поэтому ошибки upstream при отладке
  не видны — для диагностики канарейки это приходилось обходить;
- общий сокет 443 говорит по HTTP/2 (его включают другие блоки), хотя наш блок
  объявляет `listen 443 ssl`; ответы при этом корректны и по h1.1, и по h2.

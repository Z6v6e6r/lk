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
- Живые операции (snapshot, `nginx -t/-T`, reload, install, probes, активация):
  **не выполнялись**. Deploy и activation остаются отдельными разрешениями.

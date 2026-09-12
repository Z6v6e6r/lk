# Partner Game Membership API: выдача доступа и эксплуатация

Внутренний документ PadlHub. Партнёру не передаётся. Описывает, как выдать рабочему
клиенту партнёра доступ к активированному endpoint, как его отозвать и как выкатить
новый релиз sidecar. Партнёрская часть — в
`partner-game-membership-integration-guide/` (начиная с `ACCESS_REQUEST.md`).

**Любое действие в этом документе, затрагивающее боевой контур, требует отдельного
разрешения владельца.** Регламент описывает порядок, а не выдаёт разрешение.

## 0. Живая топология (актуально на 2026-09-12)

| Элемент | Значение |
| --- | --- |
| Хост sidecar | `lk-primary-147` (`147.45.103.3`), SSH только через jump `lk-reserve-89` |
| Ingress | общий 443, `server_name partner-api.padlhub.su`, mTLS обязателен |
| Конфиг ingress | `/etc/nginx/conf.d/partner-game-membership-api-v02.conf` |
| Sidecar unit | `partner-game-membership-sidecar.service`, listener только `127.0.0.1:18894` |
| Релизы | `/opt/padlhub/partner-game-membership/releases/<version>` |
| `current` | симлинк на активный релиз |
| Анкор запуска | `/etc/padlhub/partner-game-membership/approved-startup.json` (`0640 root:partner-game-api`) |
| Секреты и keyring | `/etc/padlhub/partner-game-membership/service.env` (`0640 root:partner-game-api`) |
| Drop-in активации | `/etc/systemd/system/partner-game-membership-sidecar.service.d/zz-activation.conf` |
| State и audit | `/var/lib/padlhub/partner-game-membership` (`0700`) |
| Сервисный пользователь | `partner-game-api` (`uid 995`) |
| Mongo | `147.45.254.160:27017`, БД `games`, `directConnection=true`, `authSource=admin` |
| Egress sidecar | `IPAddressAllow`: `localhost`, `147.45.254.160/32`, `91.219.191.8/32` |

## 1. Входные данные

Соберите по `ACCESS_REQUEST.md`: контакты, окружения, CSR, исходящие IP, игры и станции
с вместимостью, желаемый `clientId`/`keyId`, канал передачи секрета. Без CSR и
статических адресов выдача не начинается.

## 2. Запись клиента в keyring

Keyring — JSON в `service.env`, переменная `LK_PARTNER_GAME_API_KEYRING_JSON`:

```json
{
  "<clientId>": {
    "enabled": true,
    "scopes": ["members:add", "members:remove", "operations:read"],
    "stationIds": ["<station-uuid>"],
    "games": { "<gameId>": { "tenantKey": null, "capacity": 4 } },
    "keys": { "<keyId>": "<base64url secret, 32 bytes>" }
  }
}
```

Правила:

1. Секрет — 32 случайных байта в base64url (43 символа):
   `node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'`.
   Генерируется на нашей стороне и передаётся партнёру согласованным каналом.
2. `games` — только то, что выдано; `capacity` должна соответствовать игре.
3. `stationIds` — станции выданных игр.
4. Ключ добавляется новым `keyId`, старый не перезаписывается: это и есть ротация без
   разрыва.
5. Отзыв — `enabled: false` либо удаление клиента из keyring; после этого запросы
   получают `403 CLIENT_DISABLED` / `401 INVALID_SIGNATURE`.
6. Файл остаётся `0640 root:partner-game-api`; после правки — `systemctl restart
   partner-game-membership-sidecar.service`.

Проверка формы записи без вывода секрета:

```sh
node -e 'const fs=require("fs");const raw=fs.readFileSync("/etc/padlhub/partner-game-membership/service.env","utf8");
const env={};for(const l of raw.split("\n")){const m=l.match(/^([A-Z0-9_]+)=(.*)$/);if(m)env[m[1]]=m[2];}
const k=JSON.parse(env.LK_PARTNER_GAME_API_KEYRING_JSON);
for(const [id,c] of Object.entries(k))console.log(id,"enabled="+c.enabled,"scopes="+c.scopes.join(","),"games="+Object.keys(c.games).join(","),"keys="+Object.keys(c.keys).join(","));'
```

## 3. Подпись клиентского сертификата

Приватный ключ партнёра у нас не появляется: только CSR.

```sh
openssl req -in partner.csr -noout -subject -verify      # CSR валиден и CN совпадает
openssl x509 -req -in partner.csr -CA partner-client-ca.crt -CAkey partner-client-ca.key \
  -CAcreateserial -days 365 -sha256 -out partner-client.crt
openssl verify -CAfile partner-client-ca.crt partner-client.crt
```

Партнёру возвращаются `partner-client.crt` и `partner-client-ca.crt`. Сертификат привязан
к одному окружению и одному клиенту.

**Известный пробел:** nginx доверяет клиентскому CA (`ssl_client_certificate` +
`ssl_verify_client on`) и не проверяет CRL/OCSP. Отзыв отдельного сертификата до
истечения срока сейчас возможен только через замену CA или через отключение клиента в
keyring. Если партнёру нужен настоящий отзыв по сертификату — это отдельная работа по
ingress.

## 4. Ingress: client id и allowlist

В текущем конфиге клиент зашит точечно:

```nginx
if ($http_x_padlhub_client_id != "padlhub-canary") { return 403; }
location / {
  allow 109.173.114.67;
  allow 89.108.64.209;
  deny all;
  ...
}
```

Для партнёра правка обязательна и является отдельным ревьюируемым изменением боевого
контура:

1. заменить точечную проверку на `map $http_x_padlhub_client_id $pgm_v02_client_allowed
   { default 0; "<partnerClientId>" 1; ... }` и проверять этот флаг;
2. добавить исходящие адреса партнёра в `allow`, сохранив `deny all` последним;
3. `nginx -t`, затем `systemctl reload nginx`;
4. обновить пин конфига ingress и сопутствующее evidence: изменение конфига делает
   прежний `configSha256` недействительным;
5. одновременно проверить, что `limit_req`/`limit_conn` покрывают ожидаемую нагрузку
   партнёра (текущие: 2 rps и 4 соединения на клиента, 5 rps и 8 соединений на источник).

Широкий `default 1` или `allow all` в этом блоке запрещены: маршрут открыт публично и
защищён именно этой парой проверок.

## 5. Активация endpoint

Активация — не следствие успешной установки, а отдельное решение. Порядок:

1. выпустить релиз (раздел 6) и убедиться, что `packet.manifest.json` совпадает по
   байтам;
2. записать анкор `/etc/padlhub/partner-game-membership/approved-startup.json`
   (`0640 root:partner-game-api`):

```json
{
  "formatVersion": 1,
  "mode": "BOUND_ACTIVE",
  "expectedHost": "partner-api.padlhub.su",
  "expectedAudience": "padlhub-partner-game-prod",
  "candidateFlowSha256": "<из packet>",
  "releaseDirectory": "/opt/padlhub/partner-game-membership/releases/<version>",
  "packetManifestSha256": "<sha256 packet.manifest.json>",
  "approvedCommit": "<40-hex>",
  "approvedTree": "<40-hex>",
  "activationAuthorized": true,
  "canaryClientId": "<единственный enabled client в keyring>",
  "canaryGameIds": ["<1–8 игр, включая все игры этого клиента>"]
}
```

3. выставить гейты (drop-in `zz-activation.conf`):

```ini
[Service]
Environment=LK_PARTNER_GAME_API_STARTUP_MODE=BOUND_ACTIVE
Environment=LK_PARTNER_GAME_API_ENABLED=true
Environment=LK_PARTNER_GAME_API_PROVIDER_MODE=viva
Environment=LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED=true
Environment=LK_PARTNER_GAME_API_VIVA_CONTRACT_REVISION=padlhub-viva-technical-booking-v1
Environment=LK_PARTNER_GAME_API_VIVA_IDEMPOTENCY_CONFIRMED=true
Environment=LK_PARTNER_GAME_API_VIVA_ON_PLACE_CONFIRMED=true
```

4. `systemctl daemon-reload`, проверить эффективное окружение
   (`systemctl show -p Environment partner-game-membership-sidecar.service`) **до**
   рестарта: порядок drop-in лексикографический, `bound.conf` объявляет
   `BOUND_DEFAULT_OFF` и должен перекрываться файлом, который читается позже;
5. `ln -sfn releases/<version> current`, `systemctl restart`;
6. убедиться, что сервис `active`, слушатель только `127.0.0.1:18894` и в журнале есть
   `Started flows` без `PARTNER_GUARDED_STARTUP_REFUSED`.

Гвард связан с anchor: `activationAuthorized` живёт только в root-owned анкоре, packet
manifest активацию не авторизует, а keyring обязан совпадать с `canaryClientId` и
`canaryGameIds`. Пока в keyring один клиент, `canaryGameIds` — его игры; при выдаче
второго клиента набор и логика привязки требуют отдельного пересмотра (см. раздел 8).

## 6. Установка релиза sidecar

```sh
# 1. свежий live-pull (workspace вне репозитория, canonical path, 0700)
scp -o ProxyJump=lk-reserve-89 root@lk-primary-147:/root/.node-red/flows.json <ws>/input/source.flow.json
#    + source.flow.meta.json тем же генератором, что в scripts/pull_nodered_source_from_147.sh

# 2. пакет
node scripts/prepare_partner_game_membership_v02_packet.mjs --workspace <ws> --out <private-0700-parent>/packet

# 3. доставка без AppleDouble
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf /tmp/packet.tgz -C <packet> .

# 4. на хосте: распаковать в новый releases/<version>, сверить каждый файл с manifest,
#    затем custody и runtime
find <release> -name '._*' -delete
chown -R root:partner-game-api <release>; find <release> -type d -exec chmod 750 {} +; find <release> -type f -exec chmod 640 {} +
cd <release>/runtime && npm ci --ignore-scripts --no-fund --no-audit
<release>/runtime/node_modules/.bin/node-red --version          # ожидается 5.0.6
ls -l <release>/runtime/node_modules/@padlhub/node-red-partner-game-membership-api  # symlink на ../../partner-package
```

Проверка байтов (обязательна до переключения `current`):

```sh
node -e 'const fs=require("fs"),c=require("crypto"),p=require("path");const root=process.argv[1];
const m=JSON.parse(fs.readFileSync(p.join(root,"packet.manifest.json")));let bad=0;
for(const f of m.files){const h=c.createHash("sha256").update(fs.readFileSync(p.join(root,f.relativePath))).digest("hex");if(h!==f.sha256){console.log("MISMATCH",f.relativePath);bad++;}}
console.log("entries",m.files.length,"mismatches",bad);' <release>
```

`node_modules` не переставляем по правам: `.bin/node-red` должен остаться исполняемым.

## 7. Откат и выключение

1. Быстрое выключение API без смены релиза: заменить анкор на `BOUND_DEFAULT_OFF` **и**
   снять/нейтрализовать `zz-activation.conf`. Одного анкора недостаточно: с
   `ENABLED=true` без активного анкора гвард откажет в старте, и сервис не поднимется.
2. Возврат на предыдущий релиз: `ln -sfn releases/<previous> current` и анкор под него,
   затем `systemctl restart`.
3. Полное выключение маршрута: `systemctl disable --now
   partner-game-membership-sidecar`, убрать конфиг ingress, `nginx -t`, `reload`.
4. **Не удалять** `ledgers`/audit в state-каталоге до reconciliation: там nonce-ledger,
   операции и audit.

## 8. Канареечный клиент: вывод из эксплуатации

Пока endpoint обслуживает только наш канареечный клиент, действует ограничение:
гвард требует ровно один `enabled` клиент, равный `canaryClientId` анкора. Перед выдачей
доступа партнёру нужно одно из двух:

- **Заменить** канареечного клиента партнёрским: заменить запись в keyring, обновить
  `canaryClientId`/`canaryGameIds` в анкоре (уже под новый набор игр), убрать точечную
  проверку `padlhub-canary` в nginx, удалить канареечные `client.pem`/`client.key` с
  резервного хоста и временные helper-скрипты.
- **Расширить** контракт гварда на несколько клиентов: это изменение кода и отдельное
  ревью, потому что текущая модель намеренно ограничивает радиус активации одним
  клиентом.

Не оставляйте канареечный приватный ключ на резервном хосте после выдачи партнёрских
доступов.

## 9. Обязательства по evidence

- Изменение любого файла custom node или sidecar делает прежний runtime-closure
  недействительным: требуется перевыпуск functional rehearsal и runtime-manifest,
  пересборка пакета и обновление `production_controls.json`, констант валидатора и
  `CONTROLS_PIN`.
- Изменение ingress-конфига делает недействительным его `configSha256`.
- Порядок и границы замка описаны в `PARTNER_GAME_MEMBERSHIP_GUARDED_RELEASE.md`;
  партнёрские и внутренние документы не должны расходиться по форме запросов, статусам
  и кодам ошибок — при расхождении верна реализация, а документ пересматривается.

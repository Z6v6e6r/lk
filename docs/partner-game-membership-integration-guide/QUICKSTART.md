# Быстрый старт

Цель — за один проход собрать подпись, отправить `POST`, прочитать операцию и удалить
участника. Боевой endpoint развёрнут и активирован, но ваш Host/SNI, `clientId`,
`keyId`, секрет и mTLS-сертификат ещё не выданы: шаг 0 проверяется офлайн, а шаги 3–5
показывают точную форму запросов — подставьте выданные значения, когда они придут
(см. [ACCESS_REQUEST.md](ACCESS_REQUEST.md)).

Требуется Node.js 18+ (только для примеров и `sign.mjs`).

## Шаг 0 — проверить свою реализацию офлайн

```sh
cd ../partner-game-membership-kit
node contract-selftest.mjs --self-test
# OFFLINE_CONTRACT_VECTORS_PASS vectors=5 network=NOT_USED live_security=NOT_TESTED
```

Затем сверьте свой подписывающий код с референсным `sign.mjs` на публичном vector:

```sh
cd ../partner-game-membership-integration-guide
printf '%s' '{"externalPlayerId":"player-001","displayName":"Test Player","payment":{"reference":"pay-001","paidAt":"2026-09-01T08:59:00.000Z","amountMinor":250000,"currency":"RUB"}}' > /tmp/member.json
node sign.mjs \
  --client-id partner-test --audience padlhub-partner-game-test \
  --key-id key-2026-09 --secret 'public-test-vector-key-32-bytes!!' --secret-format utf8 \
  --method POST --path /lk/integrations/v1/open-games/game-001/members \
  --body /tmp/member.json --timestamp 1788253200 --nonce MDEyMzQ1Njc4OWFiY2RlZjAxMjM0 \
  --idempotency-key 11111111-1111-4111-8111-111111111111 \
  --correlation-id 22222222-2222-4222-8222-222222222222 --json
```

Ожидаемая подпись — `v2=JclK7-2hTze2KrNOPMuK0UdEO5DO2T5v6geJxxjRCAo`. Если ваша
реализация даёт другое значение — не идите дальше, пока не совпадёт: см.
[SIGNING.md](SIGNING.md).

## Шаг 1 — тело POST

```json
{
  "externalPlayerId": "player-42",
  "displayName": "Иван П.",
  "payment": {
    "reference": "order-2026-000123",
    "paidAt": "2026-09-11T12:00:00.000Z",
    "amountMinor": 250000,
    "currency": "RUB"
  }
}
```

`externalPlayerId` — стабильный ID игрока у вас; `payment.reference` — уникальная
ссылка на расчёт в вашем приложении.

## Шаг 2 — подпись боевым ключом

```sh
node sign.mjs \
  --client-id "$PADLHUB_CLIENT_ID" --audience "$PADLHUB_AUDIENCE" \
  --key-id "$PADLHUB_KEY_ID" --secret "$PADLHUB_SECRET" \
  --method POST --path "/lk/integrations/v1/open-games/$GAME_ID/members" \
  --body /tmp/member.json --json
```

Сохраните `Idempotency-Key` из вывода: он понадобится для повтора той же команды.

## Шаг 3 — отправить POST

Если сертификат пришёл как PKCS#12, сначала распакуйте его в PEM-пару — curl и большинство
HTTP-клиентов работают с ней напрямую (пароль спросит openssl):

```sh
openssl pkcs12 -in client.p12 -clcerts -nokeys -out client.crt
openssl pkcs12 -in client.p12 -nocerts -nodes -out client.key
chmod 600 client.crt client.key
```

```sh
curl --fail-with-body --http1.1 \
  --cert client.crt --key client.key --cacert padlhub-ca.pem \
  -X POST "https://<ВЫДАННЫЙ_ХОСТ>/lk/integrations/v1/open-games/$GAME_ID/members" \
  -H 'Content-Type: application/json' \
  -H "X-PadlHub-Client-Id: $PADLHUB_CLIENT_ID" \
  -H "X-PadlHub-Audience: $PADLHUB_AUDIENCE" \
  -H "X-PadlHub-Key-Id: $PADLHUB_KEY_ID" \
  -H "X-PadlHub-Timestamp: $TS" -H "X-PadlHub-Nonce: $NONCE" \
  -H "X-PadlHub-Signature: $SIGNATURE" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" -H "X-Correlation-ID: $CORRELATION_ID" \
  --data "$(cat /tmp/member.json)"
```

Ответ — `201` (первый успех), `200` (идемпотентный повтор) или `202` (результат
неизвестен). Пример `201` в [ENDPOINTS.md](ENDPOINTS.md).

### Вариант на Node.js

```js
import crypto from "node:crypto";

const VERSION = "PADLHUB-PARTNER-GAME-V2";
const canonical = (v) => v === null || typeof v !== "object"
  ? JSON.stringify(Number.isSafeInteger(v) || typeof v !== "number" ? (Object.is(v, -0) ? 0 : v) : v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;

async function call(method, path, body, ctx) {
  const canonicalBody = canonical(body ?? {});
  const bodySha256 = crypto.createHash("sha256").update(canonicalBody).digest("hex");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("base64url");
  const correlationId = crypto.randomUUID();
  const input = [VERSION, ctx.audience, ctx.clientId, ctx.keyId, timestamp, nonce,
    method, path, bodySha256, ctx.idempotencyKey, correlationId].join("\n");
  const signature = `v2=${crypto.createHmac("sha256", Buffer.from(ctx.secret, "base64url"))
    .update(input).digest("base64url")}`;
  const headers = {
    "X-PadlHub-Client-Id": ctx.clientId, "X-PadlHub-Audience": ctx.audience,
    "X-PadlHub-Key-Id": ctx.keyId, "X-PadlHub-Timestamp": timestamp,
    "X-PadlHub-Nonce": nonce, "X-PadlHub-Signature": signature,
    "Idempotency-Key": ctx.idempotencyKey, "X-Correlation-ID": correlationId,
  };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method, headers,
    body: method === "GET" ? undefined : canonicalBody,
  });
  return { status: response.status, body: await response.json() };
}
```

## Шаг 4 — прочитать операцию

```sh
curl --fail-with-body --http1.1 \
  --cert client.crt --key client.key --cacert padlhub-ca.pem \
  "https://<ВЫДАННЫЙ_ХОСТ>/lk/integrations/v1/operations/$OPERATION_ID" \
  -H "X-PadlHub-Client-Id: $PADLHUB_CLIENT_ID" -H "X-PadlHub-Audience: $PADLHUB_AUDIENCE" \
  -H "X-PadlHub-Key-Id: $PADLHUB_KEY_ID" -H "X-PadlHub-Timestamp: $TS" \
  -H "X-PadlHub-Nonce: $NONCE" -H "X-PadlHub-Signature: $SIGNATURE" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY_3" -H "X-Correlation-ID: $CORRELATION_ID_3"
```

Для `GET` тело не отправляется, но подпись всё равно считается по каноническому `{}`.

## Шаг 5 — удалить участника

```sh
curl --fail-with-body --http1.1 \
  --cert client.crt --key client.key --cacert padlhub-ca.pem \
  -X DELETE "https://<ВЫДАННЫЙ_ХОСТ>/lk/integrations/v1/open-games/$GAME_ID/members/$MEMBERSHIP_ID" \
  -H 'Content-Type: application/json' \
  -H "X-PadlHub-Client-Id: $PADLHUB_CLIENT_ID" -H "X-PadlHub-Audience: $PADLHUB_AUDIENCE" \
  -H "X-PadlHub-Key-Id: $PADLHUB_KEY_ID" -H "X-PadlHub-Timestamp: $TS" \
  -H "X-PadlHub-Nonce: $NONCE" -H "X-PadlHub-Signature: $SIGNATURE" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY_2" -H "X-Correlation-ID: $CORRELATION_ID_2" \
  --data '{}'
```

Тело строго `{}`. Удалить можно только membership, созданный этим же client.

## Если что-то не так

- `401 INVALID_SIGNATURE` → сверьтесь с [SIGNING.md](SIGNING.md) и повторите vector.
- `409 REQUEST_REPLAY_DETECTED` → вы переслали тот же wire-запрос.
- `202` → [IDEMPOTENCY.md](IDEMPOTENCY.md).
- Полная таблица — [ERRORS.md](ERRORS.md).

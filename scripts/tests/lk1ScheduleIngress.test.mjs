import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createGameCreateScheduleServer } from "../game-create-schedule-qa.mjs";
import { createScheduleDelegationVerifier } from "../lk1_game_create_schedule_service/verify-delegation.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("schedule ingress has one exact GET and forwards only the signed actor credentials", () => {
  const location = read("../nginx/lk2-game-create-schedule-location.conf");
  assert.match(location, /^location = \/lk\/integrations\/v1\/game-create-schedule \{/);
  assert.deepEqual([...location.matchAll(/^\s*allow (.*);$/gm)].map((match) => match[1]), [
    "103.88.243.171",
  ]);
  assert.match(location, /^\s*deny all;$/m);
  assert.match(location, /if \(\$request_method != GET\) \{ return 405; \}/);
  assert.match(location, /proxy_pass http:\/\/127\.0\.0\.1:24811;/);
  assert.match(location, /proxy_pass_request_headers off;/);
  assert.match(location, /proxy_set_header X-LK2-Schedule-Features \$http_x_lk2_schedule_features;/);
  assert.match(location, /proxy_pass_request_body off;/);
  assert.match(location, /proxy_set_header Authorization \$http_authorization;/);
  assert.match(location, /proxy_set_header X-Subscription-Actor-Delegation \$http_x_subscription_actor_delegation;/);
  assert.match(location, /proxy_next_upstream off;/);
  assert.match(location, /proxy_cache off;/);
  assert.match(location, /add_header Cache-Control "private, no-store" always;/);
  assert.match(location, /access_log off;/);
  assert.match(location, /error_log \/dev\/null;/);
});

test("shared egress cannot read schedules without a matching signed LK2 request", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    LK2_BOOKED_OPERATION_DELEGATION_ISSUER: "test-lk2",
    LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: "test-lk1",
    LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: "test-kid",
    LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }),
  };
  assert.throws(() => createScheduleDelegationVerifier({}));
  const verifyDelegation = createScheduleDelegationVerifier(env);
  let providerReads = 0;
  const server = createGameCreateScheduleServer({
    verifyDelegation,
    now: () => Date.parse("2026-12-06T05:00:00+03:00"),
    fetchImpl: async () => {
      providerReads++;
      return Response.json({ timeslots: [] });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const path = "/lk/integrations/v1/game-create-schedule";
  const search = "stationId=3656cbaa-6426-490f-a44f-915404cbdd2b&day=2026-12-06&durationMinutes=60";
  const url = `http://127.0.0.1:${server.address().port}${path}?${search}`;
  const actor = "synthetic-actor-access-token";
  const correlation = "synthetic-schedule-1";
  const now = Math.floor(Date.now() / 1_000);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = (patch = {}) => {
    const data = part({ alg: "RS256", typ: "phub-game-create-schedule+jwt", kid: "test-kid" }) + "." + part({
      iss: "test-lk2", aud: "test-lk1", sub: randomUUID(), sid: randomUUID(),
      contract_version: 1, caller: "lk2-api", provider: "VIVA",
      tenant_id: randomUUID(), tenant_key: "local-padel", jti: randomUUID(),
      scope: "game-create.schedule.read", method: "GET", path, correlation_id: correlation,
      query_sha256: hash(search), actor_token_sha256: hash(actor),
      iat: now, nbf: now, exp: now + 30, actor_token_expires_at: now + 120,
      ...patch,
    });
    return data + "." + sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
  };
  const invoke = async (delegation, target = url, token = actor, id = correlation) => {
    const response = await fetch(target, { headers: {
      Authorization: "Bearer " + token, "X-Correlation-ID": id,
      ...(delegation ? { "X-Subscription-Actor-Delegation": delegation } : {}),
    } });
    return [response.status, await response.json()];
  };
  for (const [delegation, target, token, id] of [
    [undefined], [signed() + "."],
    [signed({ scope: "game-create.whole-court.reserve" })],
    [signed({ tenant_key: "foreign" })],
    [signed({ iat: now - 40, nbf: now - 40, exp: now - 1 })],
    [signed({ iat: now + 30, nbf: now + 30, exp: now + 40 })],
    [signed({ exp: now + 61 })], [signed({ iss: "foreign" })], [signed({ aud: "foreign" })],
    [signed({ caller: "other-api" })], [signed({ contract_version: 2 })], [signed({ extra: true })],
    [signed(), url.replace("durationMinutes=60", "durationMinutes=90")],
    [signed(), url, "another-synthetic-access-token"],
    [signed(), url, actor, "other-correlation"],
  ]) assert.equal((await invoke(delegation, target, token, id))[0], 401);
  assert.equal(providerReads, 0);
  assert.deepEqual(await invoke(signed()), [200, { slots: [] }]);
  assert.equal(providerReads, 1);
});

test("separate systemd process binds loopback using an immutable release directory", () => {
  const unit = read("../lk1_game_create_schedule_service/lk1-game-create-schedule.service");
  const entry = read("../lk1_game_create_schedule_service/server.mjs");
  assert.match(
    unit,
    /^ExecStart=\/usr\/local\/bin\/node \/opt\/padlhub\/lk1-game-create-schedule\/current\/scripts\/lk1_game_create_schedule_service\/server\.mjs$/m,
  );
  assert.match(unit, /^DynamicUser=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^StartLimitBurst=3$/m);
  assert.match(entry, /server\.listen\(24811, "127\.0\.0\.1"/);
});

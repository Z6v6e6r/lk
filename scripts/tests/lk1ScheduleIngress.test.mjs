import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("schedule ingress has one exact GET and strips incoming credentials other than the actor bearer", () => {
  const location = read("../nginx/lk2-game-create-schedule-location.conf");
  assert.match(location, /^location = \/lk\/integrations\/v1\/game-create-schedule \{/);
  assert.deepEqual([...location.matchAll(/^\s*allow (.*);$/gm)].map((match) => match[1]), [
    "103.88.243.171",
  ]);
  assert.match(location, /^\s*deny all;$/m);
  assert.match(location, /if \(\$request_method != GET\) \{ return 405; \}/);
  assert.match(location, /proxy_pass http:\/\/127\.0\.0\.1:24811;/);
  assert.match(location, /proxy_pass_request_headers off;/);
  assert.match(location, /proxy_pass_request_body off;/);
  assert.match(location, /proxy_set_header Authorization \$http_authorization;/);
  assert.match(location, /proxy_next_upstream off;/);
  assert.match(location, /proxy_cache off;/);
  assert.match(location, /add_header Cache-Control "private, no-store" always;/);
  assert.match(location, /access_log off;/);
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

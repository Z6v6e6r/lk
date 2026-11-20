import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const locationSource = fs.readFileSync(
  "scripts/nginx/lk-tournament-participants-location.conf",
  "utf8",
);
const guardSource = fs.readFileSync(
  "scripts/nginx/lk-tournament-participants-guard.conf",
  "utf8",
);

test("manual participant refresh keeps the production edge guard", () => {
  assert.match(
    locationSource,
    /location = \/lk\/tournaments\/participants\/refresh \{[\s\S]*limit_req zone=lk_tournament_participants_refresh_by_ip burst=3 nodelay;/,
  );
  assert.match(
    locationSource,
    /location = \/lk\/tournaments\/participants\/refresh \{[\s\S]*Access-Control-Allow-Methods "POST, OPTIONS"/,
  );
  assert.match(
    locationSource,
    /location = \/lk\/tournaments\/participants\/refresh \{[\s\S]*proxy_next_upstream off;/,
  );
  assert.match(
    guardSource,
    /limit_req_zone \$binary_remote_addr zone=lk_tournament_participants_by_ip:10m rate=60r\/m;/,
  );
  assert.match(
    guardSource,
    /limit_req_zone \$binary_remote_addr zone=lk_tournament_participants_refresh_by_ip:10m rate=10r\/m;/,
  );
});

test("payment reconciliation has guarded POST ingress and CORS preflight", () => {
  const path = "/lk/tournaments/participants/reconcile-payment";
  const location = locationSource.split(`location = ${path} {`)[1]?.split("\n}")[0];
  assert.ok(location);
  assert.match(location, /if \(\$request_method = OPTIONS\) \{ return 204; \}/);
  assert.match(location, /limit_req zone=lk_tournament_participants_payment_by_ip burst=3 nodelay;/);
  assert.match(location, /proxy_pass http:\/\/127\.0\.0\.1:1880;/);
  assert.match(location, /proxy_next_upstream off;/);
  assert.match(guardSource, /zone=lk_tournament_participants_payment_by_ip:10m rate=10r\/m;/);
  assert.match(location, /Access-Control-Allow-Methods "POST, OPTIONS"/);
  assert.match(location, /Access-Control-Allow-Headers "Content-Type, Authorization, X-API-Key"/);
});

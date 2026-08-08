import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyCandidate,
  buildSubscriptionBookingNginxCandidate,
  readSubscriptionBookingLocation,
  sha256,
} from "../nginx/patch_subscription_booking_proxy.mjs";

const fragment = readSubscriptionBookingLocation();
const source = `server {
    listen 443 ssl;

    location ^~ /lk/ {
        alias /var/www/html/lk/;
        try_files $uri =404;
    }
}
`;

test("subscription booking location proxies only the authenticated POST route with CORS", () => {
  assert.match(fragment, /location = \/lk\/subscription-bookings \{/);
  assert.match(fragment, /proxy_pass http:\/\/127\.0\.0\.1:1880;/);
  assert.match(fragment, /Access-Control-Allow-Methods "POST, OPTIONS"/);
  assert.match(fragment, /Access-Control-Allow-Headers "Content-Type, Authorization"/);
  assert.match(fragment, /proxy_connect_timeout 2s;/);
  assert.match(fragment, /proxy_read_timeout 60s;/);
  assert.match(fragment, /proxy_next_upstream off;/);
  assert.match(fragment, /Cache-Control "no-store"/);
  assert.doesNotMatch(fragment, /Access-Control-Allow-Methods "[^"]*GET/);
});

test("guarded builder inserts one exact location before the static /lk/ handler", () => {
  const result = buildSubscriptionBookingNginxCandidate(source, sha256(source), fragment);
  assert.equal(result.changed, true);
  assert.equal(result.sourceSha, sha256(source));
  assert.equal(result.candidateSha, sha256(result.candidate));
  assert.ok(result.candidate.indexOf(fragment) < result.candidate.indexOf("location ^~ /lk/"));
  assert.equal((result.candidate.match(/location = \/lk\/subscription-bookings/g) || []).length, 1);
});

test("guarded builder is idempotent for the exact managed fragment", () => {
  const first = buildSubscriptionBookingNginxCandidate(source, sha256(source), fragment);
  const second = buildSubscriptionBookingNginxCandidate(first.candidate, first.candidateSha, fragment);
  assert.equal(second.changed, false);
  assert.equal(second.candidate, first.candidate);
});

test("guarded builder rejects source drift, conflicting routes and a missing static marker", () => {
  assert.throws(
    () => buildSubscriptionBookingNginxCandidate(source, "wrong-sha", fragment),
    /source SHA mismatch/,
  );
  const conflicting = source.replace(
    "    location ^~ /lk/ {",
    "    location = /lk/subscription-bookings { return 418; }\n\n    location ^~ /lk/ {",
  );
  assert.throws(
    () => buildSubscriptionBookingNginxCandidate(conflicting, sha256(conflicting), fragment),
    /unmanaged subscription booking nginx location/,
  );
  const missingMarker = "server { listen 443 ssl; }\n";
  assert.throws(
    () => buildSubscriptionBookingNginxCandidate(missingMarker, sha256(missingMarker), fragment),
    /marker must exist exactly once/,
  );
});

test("fragment has no embedded credentials", () => {
  assert.doesNotMatch(fragment, /password|client_secret|access_token|bearer\s+[A-Za-z0-9._-]+/i);
});

test("guarded apply creates a sibling backup and atomically installs the exact candidate", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lk-subscription-nginx-test-"));
  const livePath = path.join(directory, "padlhub.su");
  const candidatePath = path.join(directory, "padlhub.su.candidate");
  const backupPath = path.join(directory, "padlhub.su.backup");
  try {
    const built = buildSubscriptionBookingNginxCandidate(source, sha256(source), fragment);
    fs.writeFileSync(livePath, source, { mode: 0o640 });
    fs.writeFileSync(candidatePath, built.candidate);
    applyCandidate(livePath, candidatePath, built.sourceSha, built.candidateSha, backupPath);
    assert.equal(fs.readFileSync(livePath, "utf8"), built.candidate);
    assert.equal(fs.readFileSync(backupPath, "utf8"), source);
    assert.equal(fs.statSync(livePath).mode & 0o777, 0o640);
    assert.equal(fs.statSync(backupPath).mode & 0o777, 0o640);
    assert.throws(
      () => applyCandidate(livePath, candidatePath, built.sourceSha, built.candidateSha, `${backupPath}.second`),
      /source SHA mismatch/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

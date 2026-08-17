import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  buildLkGamesCorsCandidate,
  CURRENT_ALLOWED_HEADERS,
  REQUIRED_ALLOWED_HEADERS,
  sha256,
} from "../nginx/patch_lk_games_cors.mjs";

const block = (start, headers = CURRENT_ALLOWED_HEADERS) => `${start} {
    proxy_pass http://127.0.0.1:1880;
    proxy_hide_header Access-Control-Allow-Origin;
    proxy_hide_header Access-Control-Allow-Methods;
    proxy_hide_header Access-Control-Allow-Headers;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "GET, POST, PATCH, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "${headers}" always;
    if ($request_method = OPTIONS) { return 204; }
}
`;

const source = `server {
    listen 443 ssl;
    add_header Access-Control-Allow-Headers "Content-Type" always;

${block("location = /lk/games")}
${block("location ^~ /lk/games/")}
    location ^~ /lk/support/ { return 204; }
}
`;

test("builder patches only the nested LK Games CORS location", () => {
  const result = buildLkGamesCorsCandidate(source, sha256(source));
  assert.equal(result.changed, true);
  assert.equal(result.locations.length, 1);
  assert.equal(result.locations.filter((location) => location.changed).length, 1);
  assert.equal(result.changedLineCount, 1);
  assert.equal(
    (
      result.candidate.match(
        new RegExp(`Access-Control-Allow-Headers "${REQUIRED_ALLOWED_HEADERS}"`, "g"),
      ) || []
    ).length,
    1,
  );
  assert.equal(
    (
      result.candidate.match(
        new RegExp(`Access-Control-Allow-Headers "${CURRENT_ALLOWED_HEADERS}"`, "g"),
      ) || []
    ).length,
    1,
  );
  assert.match(result.candidate, /add_header Access-Control-Allow-Headers "Content-Type" always;/);
  assert.equal(result.candidateSha256, sha256(result.candidate));
});

test("builder is idempotent for the exact managed headers", () => {
  const first = buildLkGamesCorsCandidate(source, sha256(source));
  const second = buildLkGamesCorsCandidate(first.candidate, first.candidateSha256);
  assert.equal(second.changed, false);
  assert.equal(second.candidate, first.candidate);
  assert.equal(second.changedLineCount, 0);
});

test("builder rejects SHA drift and unmanaged nested headers", () => {
  assert.throws(() => buildLkGamesCorsCandidate(source, "wrong"), /source SHA mismatch/);
  const unmanaged = source.replace(
    block("location ^~ /lk/games/"),
    block("location ^~ /lk/games/", "Content-Type, Authorization"),
  );
  assert.throws(
    () => buildLkGamesCorsCandidate(unmanaged, sha256(unmanaged)),
    /unmanaged Allow-Headers/,
  );
});

test("builder rejects missing, duplicated and structurally unsafe locations", () => {
  const missing = source.replace(block("location ^~ /lk/games/"), "");
  assert.throws(
    () => buildLkGamesCorsCandidate(missing, sha256(missing)),
    /must exist exactly once/,
  );
  const duplicated = `${source}\n${block("location ^~ /lk/games/")}`;
  assert.throws(
    () => buildLkGamesCorsCandidate(duplicated, sha256(duplicated)),
    /must exist exactly once/,
  );
  const nestedBlock = block("location ^~ /lk/games/");
  const noHide = source.replace(
    nestedBlock,
    nestedBlock.replace("    proxy_hide_header Access-Control-Allow-Headers;\n", ""),
  );
  assert.throws(
    () => buildLkGamesCorsCandidate(noHide, sha256(noHide)),
    /must hide exactly one/,
  );
});

test("CLI writes private exclusive candidate and report artifacts", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lk-games-cors-nginx-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "padlhub.su");
  const output = path.join(directory, "padlhub.su.candidate");
  const report = path.join(directory, "report.json");
  fs.writeFileSync(input, source, { mode: 0o600 });

  const result = spawnSync(process.execPath, [
    "scripts/nginx/patch_lk_games_cors.mjs",
    "--input", input,
    "--output", output,
    "--report", report,
    "--expected-sha256", sha256(source),
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(report).mode & 0o777, 0o600);
  const parsedReport = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(parsedReport.invariants.changedLocationCount, 1);
  assert.equal(parsedReport.invariants.changedLineCount, 1);

  const replay = spawnSync(process.execPath, [
    "scripts/nginx/patch_lk_games_cors.mjs",
    "--input", input,
    "--output", output,
    "--report", report,
    "--expected-sha256", sha256(source),
  ], { encoding: "utf8" });
  assert.notEqual(replay.status, 0);
  assert.match(replay.stderr, /Refusing to overwrite/);
});

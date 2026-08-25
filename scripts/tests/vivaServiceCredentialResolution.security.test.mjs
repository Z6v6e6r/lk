import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NODE_RED_SOURCES = [
  "fn_referral_subscription_confirm_resolve.js",
  "fn_referral_subscription_owner_resolve.js",
  "fn_referral_subscription_purchase_prepare.js",
  "fn_referral_subscription_status_prepare.js",
  "fn_tournament_subscription_confirm_resolve.js",
  "fn_tournament_subscription_purchase_limit.js",
];
const REPAIR_SOURCES = [
  "scripts/repair_missing_split_exercise_ids.mjs",
  "scripts/repair_split_timeout_false_positives.mjs",
  "scripts/reconcile_ab_leto_viva_sales.mjs",
];

const sourcePath = (name) => path.join(REPO_ROOT, "scripts/nodered_games_nodes", name);
const source = (name) => fs.readFileSync(sourcePath(name), "utf8");

function resolveTokenBody(name, envValues = {}, globalValue) {
  const body = source(name);
  const builderStart = body.indexOf("const buildVivaServiceTokenRequestBody");
  const builderEnd = body.indexOf("\n\n", builderStart);
  assert.ok(builderStart >= 0 && builderEnd > builderStart, `${name} token-body builder`);
  const global = { get: (key) => key === "vivacrm_token_request_body" ? globalValue : undefined };
  const env = { get: (key) => envValues[key] };
  return new Function("global", "env", `${body.slice(0, builderEnd)}\nreturn buildVivaServiceTokenRequestBody();`)(global, env);
}

test("six subscription sources resolve service authorization by documented precedence", () => {
  for (const name of NODE_RED_SOURCES) {
    assert.equal(
      resolveTokenBody(name, { VIVACRM_TOKEN_REQUEST_BODY: "env-token-body" }, "global-token-body"),
      "env-token-body",
      `${name}: env body wins`,
    );
    assert.equal(
      resolveTokenBody(name, {}, "global-token-body"),
      "global-token-body",
      `${name}: protected global body wins over fields`,
    );
    const perField = new URLSearchParams(resolveTokenBody(name, {
      VIVA_SERVICE_USERNAME: "service-user",
      VIVA_SERVICE_PASSWORD: "service-password",
      VIVA_SERVICE_CLIENT_ID: "service-client",
    }));
    assert.equal(perField.get("username"), "service-user", `${name}: username is env-derived`);
    assert.equal(perField.get("password"), "service-password", `${name}: password is env-derived`);
    assert.equal(perField.get("client_id"), "service-client", `${name}: client id is env-derived`);
    assert.equal(resolveTokenBody(name), null, `${name}: missing config fails closed`);
  }
});

test("reviewed sources contain no inline credential body and only dynamic constructors", () => {
  for (const name of NODE_RED_SOURCES) {
    const body = source(name);
    assert.doesNotMatch(body, /grant_type=password(?:&|["'])/, name);
    assert.doesNotMatch(body, /(?:username|password)=[^&"'\s]+/, name);
    assert.match(body, /buildVivaServiceTokenRequestBody/, name);
    assert.match(body, /VIVA_SERVICE_USERNAME/, name);
    assert.match(body, /VIVA_SERVICE_PASSWORD/, name);
  }
  for (const relativePath of REPAIR_SOURCES) {
    const body = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    assert.doesNotMatch(body, /--viva-(?:username|password)/, relativePath);
    assert.match(body, /VIVACRM_TOKEN_REQUEST_BODY/, relativePath);
    assert.match(body, /VIVA_SERVICE_AUTH_NOT_CONFIGURED/, relativePath);
  }
});

test("tracked current code and snapshots contain no inline password grant credentials", () => {
  const trackedSources = execFileSync("git", ["ls-files", "-z", "--", "*.js", "*.mjs", "*.json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const currentFiles = Array.from(new Set([
    ...NODE_RED_SOURCES.map((name) => path.join("scripts/nodered_games_nodes", name)),
    ...REPAIR_SOURCES,
    ...trackedSources,
  ]));
  const inlineGrant = /(?:[A-Za-z_][A-Za-z0-9_]*=[^&"'\\\s]+&)*grant_type=password(?:&[A-Za-z_][A-Za-z0-9_]*=[^&"'\\\s]+)+/g;
  const isExplicitSentinel = (value, field) => {
    const decoded = decodeURIComponent(value).trim();
    if (!/^[A-Z0-9_:-]+$/.test(decoded)) return false;
    if (!/(?:REDACTED|PLACEHOLDER|REQUIRED|YOUR)/.test(decoded)) return false;
    return field === "username"
      ? /(?:USERNAME|LOGIN|USER)/.test(decoded)
      : /PASSWORD/.test(decoded);
  };
  const assertNoInlineCredential = (current, currentFile) => {
    for (const match of current.matchAll(inlineGrant)) {
      const fields = new URLSearchParams(match[0]);
      const username = fields.get("username");
      const password = fields.get("password");
      if (!username && !password) continue;
      assert.ok(
        Boolean(username && password)
          && isExplicitSentinel(username, "username")
          && isExplicitSentinel(password, "password"),
        `${currentFile}: inline password grant must contain explicit non-secret sentinels`,
      );
    }
  };

  assert.throws(
    () => assertNoInlineCredential(
      [
        "username=unsafe-user",
        "grant_type=password",
        "password=unsafe-password",
        "client_id=unsafe-client",
      ].join("&"),
      "synthetic-reordered-body",
    ),
    /inline password grant must contain explicit non-secret sentinels/,
  );

  for (const currentFile of currentFiles) {
    const current = fs.readFileSync(path.join(REPO_ROOT, currentFile), "utf8");
    assertNoInlineCredential(current, currentFile);
  }
});

test("repair CLIs reject missing service authorization before input or network work", () => {
  for (const relativePath of REPAIR_SOURCES) {
    const result = spawnSync(process.execPath, [relativePath, "--input-file", "/definitely/not/a/real/input.json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
      },
    });
    assert.notEqual(result.status, 0, relativePath);
    assert.match(result.stderr, /VIVA_SERVICE_AUTH_NOT_CONFIGURED/, relativePath);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /service-password|service-user/, relativePath);
  }
});

test("offline repair mode does not require Viva service authorization", () => {
  const relativePath = "scripts/repair_missing_split_exercise_ids.mjs";
  const result = spawnSync(process.execPath, [
    relativePath,
    "--no-viva",
    "--lk-base",
    "file:///definitely/not/a/real/lk",
    "--out",
    "/dev/null",
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
    },
  });
  assert.notEqual(result.status, 0, relativePath);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /VIVA_SERVICE_AUTH_NOT_CONFIGURED/, relativePath);
});

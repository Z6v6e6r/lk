import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_BUILD_ENV_KEYS,
  releaseArtifactNames,
  validateBuildEnv,
  validateBundleRuntimeConfig,
} from "../lib/build-env.mjs";

const testPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(testPath, "../../..");
const buildEnvScript = resolve(repoRoot, "scripts/assert-build-env.mjs");
const validEnv = Object.fromEntries(
  REQUIRED_BUILD_ENV_KEYS.map((key) => [
    key,
    key === "VITE_TENANT_KEY" ? "tenant" : `https://example.com/${key.toLowerCase()}`,
  ]),
);

test("accepts a complete build environment", () => {
  assert.deepEqual(validateBuildEnv(validEnv), []);
});

test("rejects missing and invalid critical values", () => {
  const errors = validateBuildEnv({
    ...validEnv,
    VITE_API_BASE: "undefined",
    VITE_TENANT_KEY: "",
    VITE_SERV2: "not-a-url",
  });

  assert.match(errors.join("\n"), /VITE_API_BASE is missing/);
  assert.match(errors.join("\n"), /VITE_TENANT_KEY is missing/);
  assert.match(errors.join("\n"), /VITE_SERV2 must be an absolute URL/);
});

test("rejects a bundle containing undefined API routes", () => {
  const errors = validateBundleRuntimeConfig(
    'fetch("https://padlhub.ru/undefined/end-user/api/v1/undefined/profile")',
  );

  assert.match(errors.join("\n"), /undefined API base or tenant path/);
  assert.match(errors.join("\n"), /undefined v1 tenant path/);
});

test("accepts a bundle containing configured API routes", () => {
  assert.deepEqual(
    validateBundleRuntimeConfig(
      'fetch("https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile")',
    ),
    [],
  );
});

test("rejects the production root bundle when embedded module URLs are absent", () => {
  const errors = validateBundleRuntimeConfig(
    'const communities=void 0; host({src:communities,globalName:"LKWidgetCommunities"})',
    "bundle.js",
  );

  assert.match(errors.join("\n"), /bundle\.js is missing required runtime marker/);
  assert.match(errors.join("\n"), /lk-runtime-config-v1:prod/);
});

test("accepts root bundles carrying every channel runtime marker", () => {
  const runtimeAuditFields = [
    "communitiesBundleUrl",
    "levelsInfoBundleUrl",
    "onboardingBundleUrl",
    "pushRegistrationUrl",
    "keycloakBase",
    "serv2Fallback",
  ].join(";");

  assert.deepEqual(
    validateBundleRuntimeConfig(`lk-runtime-config-v1:prod;${runtimeAuditFields}`, "bundle.js"),
    [],
  );
  assert.deepEqual(
    validateBundleRuntimeConfig(`lk-runtime-config-v1:dev;${runtimeAuditFields}`, "bundle-dev.js"),
    [],
  );
});

test("maps every release manifest to the artifacts it publishes", () => {
  assert.deepEqual(releaseArtifactNames("release.json"), [
    "bundle.js",
    "games.js",
    "tournaments.js",
    "tournament-signup.js",
    "group-schedule.js",
    "padel-day-schedule.js",
    "tournament-subscription.js",
    "tournament-subscription-referral.js",
    "onboarding.js",
    "levels-info.js",
    "communities.js",
  ]);
  assert.deepEqual(releaseArtifactNames("release-dev.json"), [
    "bundle-dev.js",
    "games-dev.js",
    "tournaments-dev.js",
    "tournament-signup-dev.js",
    "group-schedule-dev.js",
    "padel-day-schedule-dev.js",
    "tournament-subscription-dev.js",
    "tournament-subscription-referral-dev.js",
    "onboarding-dev.js",
    "levels-info-dev.js",
    "communities-dev.js",
  ]);
  assert.deepEqual(releaseArtifactNames("release-ffc-academy.json"), [
    "ffc-academy-lk.js",
  ]);
  assert.deepEqual(releaseArtifactNames("release-ffc-academy-dev.json"), [
    "ffc-academy-lk-dev.js",
  ]);
  assert.deepEqual(releaseArtifactNames("release-unknown.json"), []);
});

test("CLI process values override env files and block invalid builds", () => {
  const result = spawnSync(process.execPath, [buildEnvScript, "production"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...validEnv,
      VITE_API_BASE: "undefined",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /VITE_API_BASE is missing/);
});

test("CLI accepts an explicit complete environment", () => {
  const result = spawnSync(process.execPath, [buildEnvScript, "production"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...validEnv,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Build environment verified/);
});

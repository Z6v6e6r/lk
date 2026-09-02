import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const workflowUrl = new URL(
  "../../.github/workflows/lk1-subscription-enforcement.yml",
  import.meta.url,
);
const workflowText = await readFile(workflowUrl, "utf8");
const workflow = load(workflowText);
const job = workflow.jobs?.["lk1-exact-head"];
const steps = job?.steps ?? [];
const step = (name) => steps.find((candidate) => candidate.name === name);
const binaryScan = () => step("Scan changed paths for secrets, PII, binaries, and runtime artifacts").run;

async function createBinaryDiffRepo(t, entries) {
  const repoDirectory = await mkdtemp(join(tmpdir(), "lk1-binary-diff-"));
  t.after(() => rm(repoDirectory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: repoDirectory });
  execFileSync(
    "git",
    ["-c", "user.name=ci", "-c", "user.email=ci", "commit", "--allow-empty", "--quiet", "-m", "base"],
    { cwd: repoDirectory },
  );
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDirectory, encoding: "utf8" }).trim();

  for (const [targetPath, sourceUrl] of entries) {
    const absoluteTarget = join(repoDirectory, targetPath);
    await mkdir(dirname(absoluteTarget), { recursive: true });
    await copyFile(sourceUrl, absoluteTarget);
  }
  execFileSync("git", ["add", "."], { cwd: repoDirectory });
  execFileSync(
    "git",
    ["-c", "user.name=ci", "-c", "user.email=ci", "commit", "--quiet", "-m", "binary fixture"],
    { cwd: repoDirectory },
  );
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDirectory, encoding: "utf8" }).trim();
  return { repoDirectory, diffRange: `${baseSha}..${headSha}` };
}

async function runBinaryScan(t, entries) {
  const { repoDirectory, diffRange } = await createBinaryDiffRepo(t, entries);
  const runnerTemp = await mkdtemp(join(tmpdir(), "lk1-binary-scan-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  return spawnSync("bash", ["-c", binaryScan()], {
    cwd: repoDirectory,
    encoding: "utf8",
    env: { ...process.env, DIFF_RANGE: diffRange, RUNNER_TEMP: runnerTemp },
  });
}

test("workflow triggers exactly for pull requests and pushes to main", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.equal(workflow.on.workflow_dispatch, undefined);
});

test("workflow keeps read-only permissions and event-safe concurrency", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(workflow.concurrency.group, /pull_request/);
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
});

test("pull-request checkout and identity use the exact PR head", () => {
  const checkout = step("Checkout exact pull-request head");
  assert.equal(checkout.if, "github.event_name == 'pull_request'");
  assert.equal(checkout.with.ref, "${{ github.event.pull_request.head.sha }}");
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with.clean, true);

  const identity = step("Resolve pull-request immutable identity");
  assert.equal(identity.if, "github.event_name == 'pull_request'");
  assert.equal(identity.env.EVENT_BASE_SHA, "${{ github.event.pull_request.base.sha }}");
  assert.equal(identity.env.EVENT_HEAD_SHA, "${{ github.event.pull_request.head.sha }}");
  assert.match(identity.run, /DIFF_RANGE=%s\.\.\.%s/);
});

test("push checkout and identity use only the exact push event fields", () => {
  const checkout = step("Checkout exact push SHA");
  assert.equal(checkout.if, "github.event_name == 'push'");
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(checkout.with.clean, true);

  const identity = step("Resolve push immutable identity");
  assert.equal(identity.if, "github.event_name == 'push'");
  assert.equal(identity.env.EVENT_BASE_SHA, "${{ github.event.before }}");
  assert.equal(identity.env.EVENT_HEAD_SHA, "${{ github.sha }}");
  assert.match(identity.run, /DIFF_RANGE=%s\.\.%s/);
  assert.doesNotMatch(JSON.stringify({ checkout, identity }), /pull_request/);
});

test("unconditional steps never reference pull-request-only event fields", () => {
  for (const candidate of steps) {
    if (!candidate.if) {
      assert.doesNotMatch(
        JSON.stringify(candidate),
        /github\.event\.pull_request/,
        `${candidate.name} must be event-safe`,
      );
    }
  }
});

test("identity and exact diff endpoints fail closed when missing", () => {
  const verify = step("Verify checkout identity and diff endpoints");
  assert.match(verify.run, /test -n "\$BASE_SHA"/);
  assert.match(verify.run, /test -n "\$EXPECTED_HEAD_SHA"/);
  assert.match(verify.run, /test -n "\$DIFF_RANGE"/);
  assert.match(verify.run, /git cat-file -e "\$BASE_SHA\^\{commit\}"/);
  assert.match(verify.run, /checked_out_sha.*EXPECTED_HEAD_SHA/s);

  assert.equal(step("Check exact event diff whitespace").run, 'git diff --check "$DIFF_RANGE"');
  assert.match(
    step("Scan changed paths for secrets, PII, binaries, and runtime artifacts").run,
    /git diff --numstat --no-renames -z "\$DIFF_RANGE"/,
  );
});

test("binary asset exceptions are exact and content-addressed", async () => {
  const scan = binaryScan();
  assert.match(scan, /git diff --numstat --no-renames -z "\$DIFF_RANGE"/);
  assert.match(scan, /read -r -d '' binary_path/);
  const allowlistEntries = [...scan.matchAll(
    /^\s+(src\/assets\/[^)]+\.webp\))\n\s+expected_hash="([0-9a-f]{64})"/gm,
  )].map((match) => [match[1].slice(0, -1), match[2]]);
  const expectedEntries = [
    [
      "src/assets/piter-subscription-rules-from-20260901.webp",
      "3e5ad8e71c42c8e46ea6cc9bfb6f0539dd09181f940c022a8956b35172ff9c12",
    ],
    [
      "src/assets/piter-subscription-tier-1.webp",
      "21868451f8dd722a99db1a555065e00bae401e2592c19a2e38e21fadcd2d590d",
    ],
  ];

  assert.deepEqual(allowlistEntries, expectedEntries);
  assert.match(scan, /sha256sum -- "\$binary_path"/);
  assert.match(scan, /"\$actual_hash" != "\$expected_hash"/);
  assert.match(scan, /Unexpected binary files in event diff/);

  for (const [assetPath, expectedHash] of expectedEntries) {
    const assetUrl = new URL(`../../${assetPath}`, import.meta.url);
    const actualHash = createHash("sha256").update(await readFile(assetUrl)).digest("hex");
    assert.equal(actualHash, expectedHash, `${assetPath} must match its CI allowlist hash`);
  }
});

test("binary scan accepts only the pinned assets and rejects path or content drift", async (t) => {
  const rulesAsset = new URL("../../src/assets/piter-subscription-rules-from-20260901.webp", import.meta.url);
  const tierAsset = new URL("../../src/assets/piter-subscription-tier-1.webp", import.meta.url);

  const allowed = await runBinaryScan(t, [
    ["src/assets/piter-subscription-rules-from-20260901.webp", rulesAsset],
    ["src/assets/piter-subscription-tier-1.webp", tierAsset],
  ]);
  assert.equal(allowed.status, 0, allowed.stderr);

  const unexpected = await runBinaryScan(t, [["src/assets/unexpected.webp", rulesAsset]]);
  assert.equal(unexpected.status, 1);
  assert.match(unexpected.stderr, /Unexpected binary files in event diff/);
  assert.match(unexpected.stderr, /src\/assets\/unexpected\.webp/);

  for (const separator of [" ", "\t", "\n"]) {
    const disguisedPath = `src/assets/piter-subscription-tier-1.webp${separator}unexpected.webp`;
    const disguised = await runBinaryScan(t, [
      ["src/assets/piter-subscription-tier-1.webp", tierAsset],
      [disguisedPath, tierAsset],
    ]);
    assert.equal(disguised.status, 1, `must reject ${JSON.stringify(disguisedPath)}`);
    assert.match(disguised.stderr, /Unexpected binary files in event diff/);
  }

  const wrongContent = await runBinaryScan(t, [
    ["src/assets/piter-subscription-rules-from-20260901.webp", tierAsset],
  ]);
  assert.equal(wrongContent.status, 1);
  assert.match(wrongContent.stderr, /Allowlisted binary hash mismatch/);
});

test("full enforcement matrix and workflow contract cannot be silently skipped", () => {
  const mandatorySteps = [
    "Validate LK1 workflow event and identity contract",
    "Run critical subscription regression matrix",
    "Run unified candidate and drift-negative tests",
    "Run tracked credential and authenticated-route security tests",
    "Validate deterministic Node-RED modular toolchain fixtures",
    "Validate combined legacy game command prerequisites",
    "Validate combined split draft persistence",
    "Validate referral attribution compatibility",
    "Fetch pinned legacy build image",
    "Validate reviewed-flow and legacy custody boundaries",
    "Typecheck",
    "Lint",
    "Build with inert compile-time configuration",
    "Scan changed paths for secrets, PII, binaries, and runtime artifacts",
  ];

  for (const name of mandatorySteps) {
    assert.ok(step(name), `${name} must remain present`);
    assert.equal(step(name).if, undefined, `${name} must not be conditional`);
  }
  assert.equal(
    step("Validate LK1 workflow event and identity contract").run,
    "node --test scripts/tests/lk1SubscriptionEnforcementWorkflow.test.mjs",
  );
  assert.match(
    step("Run unified candidate and drift-negative tests").run,
    /scripts\/tests\/lk1SubscriptionActivationPacket\.test\.mjs/,
  );
  assert.match(
    step("Validate referral attribution compatibility").run,
    /scripts\/tests\/referralAttributionReleaseCandidate\.test\.mjs/,
  );
  assert.match(
    step("Validate reviewed-flow and legacy custody boundaries").run,
    /scripts\/tests\/reviewedFlowDeploy\.test\.mjs/,
  );
  assert.match(
    step("Validate reviewed-flow and legacy custody boundaries").run,
    /scripts\/tests\/legacyGameCommandH2IdentityAudit\.test\.mjs/,
  );
  assert.match(
    step("Validate reviewed-flow and legacy custody boundaries").run,
    /scripts\/tests\/legacyGameCommandRootAclBootstrap\.test\.mjs/,
  );
  assert.equal(
    step("Fetch pinned legacy build image").run,
    "docker pull node@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a",
  );
});

test("workflow contains no manual or production mutation path", () => {
  const runCommands = steps
    .filter((candidate) => candidate.name !== "Fetch pinned legacy build image")
    .map((candidate) => candidate.run ?? "")
    .join("\n");
  assert.doesNotMatch(workflowText, /workflow_dispatch/);
  assert.doesNotMatch(
    runCommands,
    /(?:^|\n)\s*(?:ssh|scp|rsync|docker|kubectl|helm|systemctl|pm2|npm run deploy(?::|\s))/,
  );
  assert.doesNotMatch(runCommands, /(?:node-red|flows\.json).*(?:import|restart)/i);
});

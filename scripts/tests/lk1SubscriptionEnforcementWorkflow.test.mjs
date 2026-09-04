import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const binaryScanStep = () => step("Scan changed paths for secrets, PII, binaries, and runtime artifacts");
const binaryScan = () => binaryScanStep().run;

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
  return { repoDirectory, diffRange: `${baseSha}..${headSha}`, headSha };
}

async function runBinaryScanInRepo(t, { repoDirectory, diffRange, headSha }) {
  const runnerTemp = await mkdtemp(join(tmpdir(), "lk1-binary-scan-"));
  t.after(() => rm(runnerTemp, { recursive: true, force: true }));
  return spawnSync("bash", ["-c", binaryScan()], {
    cwd: repoDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: binaryScanStep().env.GIT_NO_REPLACE_OBJECTS,
      IMMUTABLE_DIFF_RANGE: diffRange,
      IMMUTABLE_HEAD_SHA: headSha,
      RUNNER_TEMP: runnerTemp,
    },
  });
}

async function runBinaryScan(t, entries) {
  return runBinaryScanInRepo(t, await createBinaryDiffRepo(t, entries));
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
  assert.match(identity.run, /head_sha=%s/);
  assert.match(identity.run, /diff_range=%s\.\.\.%s/);
  assert.match(identity.run, /GITHUB_OUTPUT/);
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
  assert.match(identity.run, /head_sha=%s/);
  assert.match(identity.run, /diff_range=%s\.\.%s/);
  assert.match(identity.run, /GITHUB_OUTPUT/);
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

test("custody checks run before any repository-controlled command can poison the job", () => {
  const whitespaceIndex = steps.indexOf(step("Check exact event diff whitespace"));
  const custodyIndex = steps.indexOf(binaryScanStep());
  const installIndex = steps.indexOf(step("Install locked dependencies"));

  assert.ok(whitespaceIndex >= 0 && custodyIndex >= 0 && installIndex >= 0);
  assert.ok(whitespaceIndex < custodyIndex, "whitespace validation must precede the custody scan");
  assert.ok(custodyIndex < installIndex, "custody scan must precede npm ci and repository scripts");

  const commandsBeforeCustody = steps
    .slice(0, custodyIndex)
    .map((candidate) => candidate.run ?? "")
    .join("\n");
  assert.doesNotMatch(commandsBeforeCustody, /npm ci|npm run|npx |node --test|scripts\//);
});

test("identity and exact diff endpoints fail closed when missing", () => {
  const verify = step("Verify checkout identity and diff endpoints");
  assert.match(verify.run, /test -n "\$BASE_SHA"/);
  assert.match(verify.run, /test -n "\$EXPECTED_HEAD_SHA"/);
  assert.match(verify.run, /test -n "\$DIFF_RANGE"/);
  assert.match(verify.run, /git cat-file -e "\$BASE_SHA\^\{commit\}"/);
  assert.match(verify.run, /checked_out_sha.*EXPECTED_HEAD_SHA/s);

  const whitespace = step("Check exact event diff whitespace");
  assert.equal(
    whitespace.run,
    'git diff --check --no-ext-diff --no-textconv "$IMMUTABLE_DIFF_RANGE"',
  );
  assert.equal(whitespace.env.GIT_NO_REPLACE_OBJECTS, "1");
  assert.match(whitespace.env.IMMUTABLE_DIFF_RANGE, /steps\.pr_identity\.outputs\.diff_range/);
  assert.match(
    binaryScan(),
    /git diff --name-only --no-renames --diff-filter=AM -z --no-ext-diff --no-textconv/,
  );
});

test("binary asset exceptions are exact and content-addressed", async () => {
  const scan = binaryScan();
  assert.match(binaryScanStep().env.IMMUTABLE_HEAD_SHA, /steps\.pr_identity\.outputs\.head_sha/);
  assert.match(binaryScanStep().env.IMMUTABLE_DIFF_RANGE, /steps\.pr_identity\.outputs\.diff_range/);
  assert.equal(binaryScanStep().env.GIT_NO_REPLACE_OBJECTS, "1");
  assert.match(scan, /test -n "\$IMMUTABLE_HEAD_SHA"/);
  assert.match(scan, /scan_checkout_sha.*IMMUTABLE_HEAD_SHA/s);
  assert.match(scan, /git status --short --untracked-files=no/);
  assert.match(scan, /git diff --name-only --no-renames --diff-filter=AM -z --no-ext-diff --no-textconv/);
  assert.match(scan, /git diff --unified=0 --no-color --no-ext-diff --no-textconv/);
  assert.match(scan, /read -r -d '' changed_path/);
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
    [
      "src/assets/network-subscription.webp",
      "83a8f2ccf39908a6cbe7b5692598fdd1624a9d0a03784cb8a6815fd69b276ef6",
    ],
    [
      "src/assets/subscription-rules-gold.webp",
      "cfa623d31076199d30b2b62149744d9845fb975f3686b681641a461eac8f2358",
    ],
    [
      "src/assets/subscription-rules-green.webp",
      "ab879147110a73dab69a196de9370fff912d009941e59a8a52ce4e89e78e617c",
    ],
    [
      "src/assets/subscription-rules-red.webp",
      "f3a9a3077865eac4cc3fb6a7be1c4f64a174795f9fefa1dfa8341ada5f2e313c",
    ],
    [
      "src/assets/summer-subscription-academy.webp",
      "1b7bdb5cf0c1f03847efac7ddf7cb9b7142187293a0d5a82190c61a79841847a",
    ],
    [
      "src/assets/summer-subscription-energy5.webp",
      "773ab011fb41d7d27ca389adfd741cefb9d8a34ac8afbf60beb307d7b514d9ba",
    ],
    [
      "src/assets/summer-subscription-friendship.webp",
      "1ec1f7fc81cd867b9ce7127ff3b03e7ee33250224bceea7bebde89dc5703ec29",
    ],
    [
      "src/assets/summer-subscription-ra.webp",
      "5f89f2f44ea1cd1d2fd1e36b8fb39a2cb6dbd9d525380b0f4d588a2139142329",
    ],
  ];

  assert.deepEqual(allowlistEntries, expectedEntries);
  assert.match(scan, /git check-attr --stdin -z diff/);
  assert.match(scan, /value !== "unspecified"/);
  assert.match(scan, /Git diff attribute override is forbidden/);
  assert.match(scan, /git cat-file blob "\$IMMUTABLE_HEAD_SHA:\$changed_path" \| sha256sum/);
  assert.match(scan, /git cat-file blob "\$IMMUTABLE_HEAD_SHA:\$changed_path"/);
  assert.match(scan, /chunk\.subarray\(0, remaining\)\.includes\(0\)/);
  assert.match(scan, /"\$actual_hash" != "\$expected_hash"/);
  assert.match(scan, /Unexpected binary files in event diff/);
  assert.match(scan, /\(\^\|\/\)\\\.gitattributes\$/);

  for (const [assetPath, expectedHash] of expectedEntries) {
    const assetUrl = new URL(`../../${assetPath}`, import.meta.url);
    const actualHash = createHash("sha256").update(await readFile(assetUrl)).digest("hex");
    assert.equal(actualHash, expectedHash, `${assetPath} must match its CI allowlist hash`);
  }
});

test("binary scan accepts only the pinned assets and rejects path or content drift", async (t) => {
  const rulesAsset = new URL("../../src/assets/piter-subscription-rules-from-20260901.webp", import.meta.url);
  const tierAsset = new URL("../../src/assets/piter-subscription-tier-1.webp", import.meta.url);
  const allowedAssetPaths = [...binaryScan().matchAll(
    /^\s+(src\/assets\/[^)]+\.webp\))\n\s+expected_hash="([0-9a-f]{64})"/gm,
  )].map((match) => match[1].slice(0, -1));

  const allowed = await runBinaryScan(
    t,
    allowedAssetPaths.map((assetPath) => [assetPath, new URL(`../../${assetPath}`, import.meta.url)]),
  );
  assert.equal(allowed.status, 0, allowed.stderr);

  const unexpected = await runBinaryScan(t, [["src/assets/unexpected.webp", rulesAsset]]);
  assert.equal(unexpected.status, 1);
  assert.match(unexpected.stderr, /Unexpected binary files in event diff/);
  assert.match(unexpected.stderr, /src\/assets\/unexpected\.webp/);

  for (const separator of [" ", "\t", "\n"]) {
    const disguisedPath = `src/assets/piter-subscription-tier-1.webp${separator}unexpected.webp`;
    const disguised = await runBinaryScan(t, [[disguisedPath, tierAsset]]);
    assert.equal(disguised.status, 1, `must reject ${JSON.stringify(disguisedPath)}`);
    if (separator === " ") {
      assert.match(disguised.stderr, /Unexpected binary files in event diff/);
    } else {
      assert.match(disguised.stderr, /Control characters in changed path are forbidden/);
    }
  }

  const wrongContent = await runBinaryScan(t, [
    ["src/assets/piter-subscription-rules-from-20260901.webp", tierAsset],
  ]);
  assert.equal(wrongContent.status, 1);
  assert.match(wrongContent.stderr, /Allowlisted binary hash mismatch/);

  const overrideDirectory = await mkdtemp(join(tmpdir(), "lk1-attribute-override-"));
  t.after(() => rm(overrideDirectory, { recursive: true, force: true }));
  const attributesPath = join(overrideDirectory, ".gitattributes");
  const payloadPath = join(overrideDirectory, "payload.bin");
  await writeFile(attributesPath, "*.bin diff\n", "utf8");
  await writeFile(payloadPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const attributeOverride = await runBinaryScan(t, [
    [".gitattributes", attributesPath],
    ["payload.bin", payloadPath],
  ]);
  assert.equal(attributeOverride.status, 1);
  assert.match(attributeOverride.stderr, /Git diff attribute override is forbidden/);
  assert.match(attributeOverride.stderr, /payload\.bin/);
});

test("custody scan rejects checkout HEAD drift after the immutable event identity is frozen", async (t) => {
  const rulesAsset = new URL("../../src/assets/piter-subscription-rules-from-20260901.webp", import.meta.url);
  const tierAsset = new URL("../../src/assets/piter-subscription-tier-1.webp", import.meta.url);
  const eventIdentity = await createBinaryDiffRepo(t, [
    ["src/assets/piter-subscription-rules-from-20260901.webp", rulesAsset],
    ["src/assets/piter-subscription-tier-1.webp", tierAsset],
  ]);
  await writeFile(join(eventIdentity.repoDirectory, "drift.txt"), "sanitized local head\n", "utf8");
  execFileSync("git", ["add", "drift.txt"], { cwd: eventIdentity.repoDirectory });
  execFileSync(
    "git",
    ["-c", "user.name=ci", "-c", "user.email=ci", "commit", "--quiet", "-m", "drift head"],
    { cwd: eventIdentity.repoDirectory },
  );

  const drifted = await runBinaryScanInRepo(t, eventIdentity);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /Exact-head checkout drifted before custody scan/);
});

test("custody scan ignores local git replacement objects", async (t) => {
  const payloadDirectory = await mkdtemp(join(tmpdir(), "lk1-replace-object-"));
  t.after(() => rm(payloadDirectory, { recursive: true, force: true }));
  const payloadPath = join(payloadDirectory, "payload.bin");
  await writeFile(payloadPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  const eventIdentity = await createBinaryDiffRepo(t, [["payload.bin", payloadPath]]);

  await writeFile(join(eventIdentity.repoDirectory, "payload.bin"), "sanitized replacement\n", "utf8");
  execFileSync("git", ["add", "payload.bin"], { cwd: eventIdentity.repoDirectory });
  execFileSync(
    "git",
    ["-c", "user.name=ci", "-c", "user.email=ci", "commit", "--quiet", "-m", "replacement"],
    { cwd: eventIdentity.repoDirectory },
  );
  const replacementSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: eventIdentity.repoDirectory,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["replace", eventIdentity.headSha, replacementSha], { cwd: eventIdentity.repoDirectory });
  execFileSync("git", ["reset", "--hard", "--quiet", eventIdentity.headSha], { cwd: eventIdentity.repoDirectory });

  const replaced = await runBinaryScanInRepo(t, eventIdentity);
  assert.equal(replaced.status, 1);
  assert.match(replaced.stderr, /Tracked files changed before custody scan|Unexpected binary files in event diff/);
});

test("full enforcement matrix and workflow contract cannot be silently skipped", () => {
  const mandatorySteps = [
    "Validate LK1 workflow event and identity contract",
    "Run critical subscription regression matrix",
    "Run unified candidate and drift-negative tests",
    "Validate LK1 DEV provisioning, bootstrap, runtime source, and read-only UAT",
    "Run tracked credential and authenticated-route security tests",
    "Run Partner membership R4 gates",
    "Run Piter atomic activation lock and ledger gates",
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
    step("Run unified candidate and drift-negative tests").run,
    /scripts\/tests\/lk1SubscriptionDevCandidate\.test\.mjs/,
  );
  assert.match(
    step("Run unified candidate and drift-negative tests").run,
    /scripts\/tests\/subscriptionBookingLegacyPatcher\.test\.mjs/,
  );
  const devBoundaryStep = step("Validate LK1 DEV provisioning, bootstrap, runtime source, and read-only UAT");
  for (const suite of [
    "scripts/tests/lk1SubscriptionDevProvisioning.test.mjs",
    "scripts/tests/lk1SubscriptionDevBootstrap.test.mjs",
    "scripts/tests/lk1SubscriptionDevRuntimeSource.test.mjs",
    "scripts/tests/lk1SubscriptionDevReleaseReceipt.test.mjs",
    "scripts/tests/lk1SubscriptionDevRuntimeInstallCandidate.test.mjs",
    "scripts/dev-uat/subscriptions-sale-period/test.mjs",
  ]) {
    assert.match(devBoundaryStep.run, new RegExp(suite.replaceAll("/", "\\/").replaceAll(".", "\\.")));
  }
  assert.match(
    step("Validate referral attribution compatibility").run,
    /scripts\/tests\/referralAttributionReleaseCandidate\.test\.mjs/,
  );
  const partnerStep = step("Run Partner membership R4 gates");
  for (const command of [
    "npm run test:partner-game-membership-api",
    "npm run validate:partner-game-membership-runtime",
    "npm run validate:partner-game-membership-production-controls",
  ]) assert.match(partnerStep.run, new RegExp(command.replaceAll(" ", "\\s+")));
  assert.equal(
    step("Run Piter atomic activation lock and ledger gates").run,
    "npm run test:piter-atomic-activation",
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

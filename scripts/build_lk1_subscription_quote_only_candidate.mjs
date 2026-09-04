#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  buildQuoteComparison,
  validateQuoteFixture,
} from "./lk1_subscription_quote_only/quote_runtime.mjs";
import {
  EXPECTED_FILES,
  validateQuoteOnlyContract,
  validateQuoteOnlyRuntime,
  validateQuoteOnlyResolverRuntime,
  validateQuoteOnlyUnit,
  verifyQuoteOnlyCandidateBundle,
} from "./verify_lk1_subscription_quote_only_candidate.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.dirname(ROOT);
const SOURCE_BY_DESTINATION = Object.freeze({
  "payload/quote_runtime.mjs": { repository: "tooling", path: "scripts/lk1_subscription_quote_only/quote_runtime.mjs" },
  "payload/quote_fixture.json": { repository: "tooling", path: "scripts/lk1_subscription_quote_only/quote_fixture.json" },
  "payload/fn_managed_subscription_policy_evaluate.js": { repository: "lk-source", path: "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js" },
  "payload/subscription-sale-period-resolver.ts": { repository: "ph-admin", path: "src/subscriptions/subscription-sale-period-resolver.ts" },
  "payload/subscription-sale-period-resolver.mjs": { repository: "tooling", path: "scripts/lk1_subscription_quote_only/subscription-sale-period-resolver.mjs" },
  "payload/quote_contract.json": { repository: "tooling", path: "scripts/lk1_subscription_quote_only/quote_contract.json" },
  "payload/lk1-subscription-dev-quote.service": { repository: "tooling", path: "scripts/lk1_subscription_quote_only/lk1-subscription-dev-quote.service" },
  "payload/verify_lk1_subscription_quote_only_candidate.mjs": { repository: "tooling", path: "scripts/verify_lk1_subscription_quote_only_candidate.mjs" },
});
const MODE = Object.freeze({
  "payload/quote_runtime.mjs": 0o550,
  "payload/verify_lk1_subscription_quote_only_candidate.mjs": 0o550,
});
const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const git = (repository, args, encoding = "utf8") => execFileSync("git", args, {
  cwd: repository, encoding, maxBuffer: 4 * 1024 * 1024,
});

function defaultIdentity(repository, sourceCommit) {
  return {
    head: git(repository, ["rev-parse", "HEAD"]).trim(),
    originMain: git(repository, ["rev-parse", "origin/main"]).trim(),
    originMainMergeBase: git(repository, ["merge-base", "HEAD", "origin/main"]).trim(),
    sourceOriginMergeBase: git(repository, ["merge-base", sourceCommit, "origin/main"]).trim(),
    headSourceMergeBase: git(repository, ["merge-base", "HEAD", sourceCommit]).trim(),
    committedAt: git(repository, ["show", "-s", "--format=%cI", "HEAD"]).trim(),
    clean: git(repository, ["status", "--porcelain"]).trim() === "",
  };
}

function compileResolver(source) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      verbatimModuleSyntax: false,
      removeComments: false,
    },
  }).outputText;
  return Buffer.from(`/* eslint-disable no-undef */\n${output.replace(/^export /gm, "")}output = resolveSubscriptionSalePeriod(input);\n`);
}

export function buildQuoteOnlyCandidateBundle({
  outputDirectory,
  lkSourceCommit,
  phAdminRepository,
  phAdminSourceCommit,
  identities = () => ({
    tooling: defaultIdentity(REPOSITORY, lkSourceCommit),
    phAdmin: defaultIdentity(phAdminRepository, phAdminSourceCommit),
  }),
  commitFile = (repository, commit, repositoryPath) => git(repository, ["show", `${commit}:${repositoryPath}`], "buffer"),
}) {
  if (!/^[a-f0-9]{40}$/.test(lkSourceCommit || "") || !/^[a-f0-9]{40}$/.test(phAdminSourceCommit || "")) {
    fail("quote candidate requires exact LK and ph-admin commits");
  }
  const identity = identities();
  if (identity.tooling.clean !== true || identity.phAdmin.clean !== true
    || !/^[a-f0-9]{40}$/.test(identity.tooling.head || "")
    || !/^[a-f0-9]{40}$/.test(identity.tooling.originMain || "")
    || identity.phAdmin.head !== phAdminSourceCommit || identity.phAdmin.originMain !== phAdminSourceCommit
    || identity.phAdmin.originMainMergeBase !== phAdminSourceCommit
    || identity.tooling.sourceOriginMergeBase !== lkSourceCommit
    || identity.tooling.headSourceMergeBase !== lkSourceCommit
    || !Number.isFinite(Date.parse(identity.tooling.committedAt))) {
    fail("quote candidate requires clean tooling and exact frozen source identities");
  }
  const root = path.resolve(outputDirectory);
  if ((!root.startsWith("/private/tmp/") && !root.startsWith("/tmp/")) || fs.existsSync(root)) {
    fail("quote candidate output must be a new temporary directory");
  }
  const bytesByDestination = new Map();
  for (const destination of EXPECTED_FILES) {
    const source = SOURCE_BY_DESTINATION[destination];
    const repository = source.repository === "ph-admin" ? phAdminRepository : REPOSITORY;
    const commit = source.repository === "lk-source" ? lkSourceCommit
      : source.repository === "ph-admin" ? phAdminSourceCommit : identity.tooling.head;
    const bytes = commitFile(repository, commit, source.path);
    if (!Buffer.isBuffer(bytes)) fail(`quote candidate source is unavailable (${source.path})`);
    if (source.repository === "tooling") {
      const workspaceBytes = fs.readFileSync(path.join(REPOSITORY, source.path));
      if (!workspaceBytes.equals(bytes)) fail(`quote tooling bytes do not belong to tooling HEAD (${source.path})`);
    }
    bytesByDestination.set(destination, bytes);
  }
  const resolverSource = bytesByDestination.get("payload/subscription-sale-period-resolver.ts");
  const checkedResolverSource = fs.readFileSync(path.join(
    REPOSITORY, "scripts/lk1_subscription_quote_only/subscription-sale-period-resolver.source.ts",
  ));
  if (!resolverSource.equals(checkedResolverSource)
    || !compileResolver(resolverSource.toString("utf8")).equals(
      bytesByDestination.get("payload/subscription-sale-period-resolver.mjs"),
    )) fail("exact ph-admin resolver source and compiled runtime are not reproducibly bound");
  validateQuoteOnlyRuntime(bytesByDestination.get("payload/quote_runtime.mjs").toString("utf8"));
  validateQuoteOnlyResolverRuntime(bytesByDestination.get("payload/subscription-sale-period-resolver.mjs").toString("utf8"));
  validateQuoteOnlyUnit(bytesByDestination.get("payload/lk1-subscription-dev-quote.service").toString("utf8"));
  validateQuoteOnlyContract(JSON.parse(bytesByDestination.get("payload/quote_contract.json").toString("utf8")));

  fs.mkdirSync(root, { mode: 0o700 });
  const files = EXPECTED_FILES.map((destination) => {
    const bytes = bytesByDestination.get(destination);
    const target = path.join(root, destination);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const mode = MODE[destination] ?? 0o440;
    fs.writeFileSync(target, bytes, { flag: "wx", mode });
    return { path: destination, mode: mode.toString(8).padStart(4, "0"), sha256: sha256(bytes), size: bytes.length };
  });
  const byPath = Object.fromEntries(files.map((row) => [row.path, row]));
  const manifest = {
    formatVersion: 1,
    stage: "LOCAL_QUOTE_ONLY_CANDIDATE",
    environment: "DEV",
    purpose: "PROVIDER_INDEPENDENT_QUOTE_ONLY",
    lkSourceCommit,
    phAdminSourceCommit,
    toolingCommit: identity.tooling.head,
    lkOriginMainAtBuild: identity.tooling.originMain,
    phAdminOriginMainAtBuild: identity.phAdmin.originMain,
    createdAt: new Date(identity.tooling.committedAt).toISOString(),
    components: {
      runtimeSha256: byPath["payload/quote_runtime.mjs"].sha256,
      fixtureSha256: byPath["payload/quote_fixture.json"].sha256,
      evaluatorSha256: byPath["payload/fn_managed_subscription_policy_evaluate.js"].sha256,
      resolverSha256: byPath["payload/subscription-sale-period-resolver.ts"].sha256,
      resolverRuntimeSha256: byPath["payload/subscription-sale-period-resolver.mjs"].sha256,
      contractSha256: byPath["payload/quote_contract.json"].sha256,
      unitSha256: byPath["payload/lk1-subscription-dev-quote.service"].sha256,
      resolverCompiler: { name: "typescript", version: ts.version, target: "ES2022", module: "ES2022" },
    },
    files,
    capabilities: {
      route: "GET /api/internal/subscriptions/dev-uat/quote-comparison",
      browserAcceptedFields: [],
      outboundHttp: 0,
      mongoOperations: [],
      provider: "NOT_INCLUDED",
      bookingWrites: "NOT_INCLUDED",
      paymentWrites: "NOT_INCLUDED",
      entitlementMutations: "NOT_INCLUDED",
      standardManualUat: "BLOCKED",
    },
    authority: {
      hostRead: false, hostInstall: false, daemonReload: false, serviceStart: false,
      enableUnit: false, ingress: false, activation: false, canaryIds: false,
      secrets: false, providerWrites: false, bookingWrites: false, paymentWrites: false,
      entitlementMutations: false, externalWrites: false,
    },
  };
  const comparison = buildQuoteComparison({
    fixture: JSON.parse(bytesByDestination.get("payload/quote_fixture.json").toString("utf8")),
    evaluatorBytes: bytesByDestination.get("payload/fn_managed_subscription_policy_evaluate.js"),
    resolverBytes: bytesByDestination.get("payload/subscription-sale-period-resolver.ts"),
    identity: {
      lkSourceCommit,
      phAdminSourceCommit,
      toolingCommit: identity.tooling.head,
      candidateManifestSha256: "0".repeat(64),
      evaluatorSha256: manifest.components.evaluatorSha256,
      resolverSha256: manifest.components.resolverSha256,
      resolverRuntimeSha256: manifest.components.resolverRuntimeSha256,
    },
    resolverRuntimeBytes: bytesByDestination.get("payload/subscription-sale-period-resolver.mjs"),
  });
  validateQuoteFixture(JSON.parse(bytesByDestination.get("payload/quote_fixture.json").toString("utf8")));
  if (comparison.results.A.selectedPolicyVersion !== 1
    || comparison.results.A.decision.eligible !== true
    || comparison.results.A.decision.finalPriceMinor !== 0
    || comparison.results.B.selectedPolicyVersion !== 2
    || comparison.results.B.decision.eligible !== true
    || comparison.results.B.decision.finalPriceMinor !== 5000
    || Object.values(comparison.writeCounters).some((value) => value !== 0)
    || comparison.standardManualUat !== "BLOCKED") {
    fail("quote candidate does not prove the exact zero-write A/V1 and B/V2 comparison");
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "manifest.json"), manifestBytes, { flag: "wx", mode: 0o600 });
  const manifestSha256 = sha256(manifestBytes);
  verifyQuoteOnlyCandidateBundle(root, manifestSha256);
  return { outputDirectory: root, manifest, manifestSha256 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 10) {
    fail("Usage: build_lk1_subscription_quote_only_candidate.mjs --output <new-temp-directory> --lk-source-commit <sha> --ph-admin-repository <path> --ph-admin-source-commit <sha>");
  }
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, index) => [
    process.argv[2 + index * 2], process.argv[3 + index * 2],
  ]));
  if (!args["--output"] || !args["--lk-source-commit"]
    || !args["--ph-admin-repository"] || !args["--ph-admin-source-commit"]) {
    fail("Usage: build_lk1_subscription_quote_only_candidate.mjs --output <new-temp-directory> --lk-source-commit <sha> --ph-admin-repository <path> --ph-admin-source-commit <sha>");
  }
  const result = buildQuoteOnlyCandidateBundle({
    outputDirectory: args["--output"],
    lkSourceCommit: args["--lk-source-commit"],
    phAdminRepository: args["--ph-admin-repository"],
    phAdminSourceCommit: args["--ph-admin-source-commit"],
  });
  process.stdout.write(`LK1_SUBSCRIPTION_QUOTE_ONLY_CANDIDATE=BUILT\nmanifestSha256=${result.manifestSha256}\noutput=${result.outputDirectory}\n`);
}

#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const PURPOSE = "PROVIDER_INDEPENDENT_QUOTE_ONLY";
const ROUTE = "/api/internal/subscriptions/dev-uat/quote-comparison";
const LK_SOURCE_COMMIT = "96ce3713742310d92fdd2d1e75ab2a9c2c046f3c";
const PH_ADMIN_SOURCE_COMMIT = "ec8bcaace29d07a5aafedabb8e7928f1d4244586";
const EVALUATOR_SHA256 = "a1fcb4f942fb265203ee7c7232fecf6b4eb9459ede5b174cc05bb2d28f1a8576";
const RESOLVER_SHA256 = "bccf5744685e3f4487d9f19387c3fff10f4fcf22a06e09f88f253caa21a5e219";
const RESOLVER_RUNTIME_SHA256 = "5ebb6fb00aa0a045074fa93ab13c43cecd3eb709b1994b9763bbb4b59f9c6650";
const RUNTIME_SHA256 = "59d89cf66a43ebf509f4c7124ae39a5e7ef12266188b0429a84943c6e71d187d";
const FIXTURE_SHA256 = "681189dfc541fe2b9ba4461b5c1177ab3bd234697baf6ebf22ec37613d713131";
const CONTRACT_SHA256 = "3e38cb3674d43ce50968969bca34218be4270a82e88ffa88502c9614619672b5";
const UNIT_SHA256 = "47a62de61d97d7d75e641d6e286b2f6db2221a8774fe6375b58cb695e38dec54";
export const EXPECTED_FILES = Object.freeze([
  "payload/quote_runtime.mjs",
  "payload/quote_fixture.json",
  "payload/fn_managed_subscription_policy_evaluate.js",
  "payload/subscription-sale-period-resolver.ts",
  "payload/subscription-sale-period-resolver.mjs",
  "payload/quote_contract.json",
  "payload/lk1-subscription-dev-quote.service",
  "payload/verify_lk1_subscription_quote_only_candidate.mjs",
]);

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} schema mismatch`);
  }
};

export function validateQuoteOnlyContract(contract) {
  exactKeys(contract, ["schemaVersion", "environment", "purpose", "listen", "route", "capabilities", "startAuthorization", "authority"], "quote contract");
  if (contract.schemaVersion !== 1 || contract.environment !== "DEV" || contract.purpose !== PURPOSE
    || JSON.stringify(contract.listen) !== JSON.stringify({ host: "127.0.0.1", port: 3040 })
    || JSON.stringify(contract.route) !== JSON.stringify({
      method: "GET", path: ROUTE, queryAllowed: false, bodyAllowed: false, browserAcceptedFields: [],
    })) fail("quote contract identity mismatch");
  if (JSON.stringify(contract.capabilities) !== JSON.stringify({
    outboundHttp: 0,
    mongoOperations: [],
    provider: "NOT_INCLUDED",
    create: "NOT_INCLUDED",
    join: "NOT_INCLUDED",
    reserve: "NOT_INCLUDED",
    release: "NOT_INCLUDED",
    payment: "NOT_INCLUDED",
    entitlementMutation: "NOT_INCLUDED",
    standardManualUat: "BLOCKED",
  })) fail("quote contract includes a write or provider capability");
  const start = contract.startAuthorization;
  if (JSON.stringify(start) !== JSON.stringify({
    transport: "SYSTEMD_STANDARD_INPUT_FILE",
    systemdMinimumVersion: 245,
    hostSupportVerified: false,
    markerPath: "/srv/lk1-subscription-dev/authorization/quote-start.approved",
    markerDirectoryOwner: "root:root",
    markerDirectoryMode: "0700",
    markerOwner: "root:root",
    markerMode: "0600",
    fd: 0,
    fdPath: "/proc/self/fd/0",
    maximumBytes: 16384,
    maximumLifetimeSeconds: 3600,
    role: "quote",
    identityFields: [
      "lkSourceCommit", "phAdminSourceCommit", "toolingCommit", "candidateManifestSha256",
      "unitSha256", "runtimeSha256", "fixtureSha256", "evaluatorSha256", "resolverSha256",
      "resolverRuntimeSha256", "nodeBinarySha256", "nodeVersion",
    ],
  })) fail("quote start authorization transport is not exact for systemd 245");
  exactKeys(contract.authority, [
    "hostInstall", "daemonReload", "serviceStart", "enableUnit", "ingress", "activation",
    "canaryIds", "secrets", "providerWrites", "bookingWrites", "paymentWrites",
    "entitlementMutations", "externalWrites",
  ], "quote contract authority");
  if (Object.values(contract.authority).some((value) => value !== false)) {
    fail("quote contract grants live or external authority");
  }
  return true;
}

export function validateQuoteOnlyUnit(source) {
  const expected = `[Unit]
Description=LK1 provider-independent DEV quote comparison (source candidate locked)
ConditionPathExists=/srv/lk1-subscription-dev/authorization/quote-start.approved
ConditionPathExists=/srv/lk1-subscription-dev/quote/quote_fixture.json
RefuseManualStart=yes

[Service]
Type=simple
User=lk1-subscription-dev
Group=lk1-subscription-dev
WorkingDirectory=/srv/lk1-subscription-dev/quote
StandardInput=file:/srv/lk1-subscription-dev/authorization/quote-start.approved
EnvironmentFile=/srv/lk1-subscription-dev/runtime/quote-install-identity.env
ExecStart=/srv/lk1-subscription-dev/runtime/node/bin/node /srv/lk1-subscription-dev/quote/quote_runtime.mjs --serve
Restart=no
RuntimeMaxSec=3600
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/srv/lk1-subscription-dev/quote
RestrictAddressFamilies=AF_INET AF_INET6
IPAddressDeny=any
IPAddressAllow=localhost
`;
  if (source !== expected) fail("quote unit is not the exact single-service systemd-245 contract");
  return true;
}

export function validateQuoteOnlyRuntime(source) {
  if (sha256(Buffer.from(source)) !== RUNTIME_SHA256) fail("quote runtime exact digest mismatch");
  if (!source.includes(`const ROUTE = "${ROUTE}"`)
    || !source.includes("readStartAuthorizationFromStandardInput")
    || !source.includes("validateStartAuthorization")
    || !source.includes("browserAcceptedFields: []")
    || !source.includes("standardManualUat: \"BLOCKED\"")) {
    fail("quote runtime lacks the exact input-free fail-closed contract");
  }
  const imports = [...source.matchAll(/^import .+ from "(node:[^"]+)";$/gm)].map((match) => match[1]);
  if (JSON.stringify(imports) !== JSON.stringify(["node:crypto", "node:fs", "node:http", "node:vm", "node:url"])) {
    fail("quote runtime Node capability imports are not exact");
  }
  const forbidden = [
    /\bfetch\s*\(/, /https?:\/\//, /node:(?:net|tls|child_process|dgram)/, /\bmongodb\b/i,
    /\bmongoose\b/i, /\bwriteFile(?:Sync)?\b/, /\bappendFile(?:Sync)?\b/,
    /\bcreateWriteStream\b/, /\bspawn(?:Sync)?\b/, /\bhttp\.(?:request|get)\s*\(/,
    /\bfs\.(?:rm|unlink|rename|chmod|chown|mkdir|rmdir|truncate|open)(?:Sync)?\s*\(/,
    /\bprocess\.(?:binding|dlopen)\s*\(/, /\bimport\s*\(/,
    /["'`]\/(?:reserve|release|payment|entitlement|join|create)(?:[/?"'`]|$)/i,
  ];
  for (const pattern of forbidden) if (pattern.test(source)) fail(`quote runtime contains forbidden capability (${pattern})`);
  const routes = [...source.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g)].map((match) => match[1]);
  if (JSON.stringify([...new Set(routes)]) !== JSON.stringify([ROUTE])) fail("quote runtime exposes an unexpected API route");
  return true;
}

export function validateQuoteOnlyResolverRuntime(source) {
  if (sha256(Buffer.from(source)) !== RESOLVER_RUNTIME_SHA256
    || !source.includes("function validateSubscriptionSalePeriodHistory(publications)")
    || !source.includes("function resolveSubscriptionSalePeriod(input)")
    || !source.endsWith("output = resolveSubscriptionSalePeriod(input);\n")
    || /^import |^export /m.test(source)
    || /\b(?:fetch|XMLHttpRequest|WebSocket|require|process|globalThis|global|module|exports|eval|Function)\b|\bimport\s*\(|https?:\/\//.test(source)) {
    fail("compiled quote resolver contains an unexpected capability or export surface");
  }
  return true;
}

function inventory(root) {
  const files = [];
  const visit = (directory) => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
      fail("quote bundle directory custody mismatch");
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else {
        const stat = fs.lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) fail("quote bundle contains a non-regular file");
        files.push(path.relative(root, absolute));
      }
    }
  };
  visit(root);
  return files.sort();
}

export function verifyQuoteOnlyCandidateBundle(rootDirectory, expectedManifestSha256) {
  const root = path.resolve(rootDirectory);
  const manifestBytes = fs.readFileSync(path.join(root, "manifest.json"));
  const manifestStat = fs.lstatSync(path.join(root, "manifest.json"));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o777) !== 0o600) {
    fail("quote candidate manifest custody mismatch");
  }
  if (!SHA256.test(expectedManifestSha256 || "") || sha256(manifestBytes) !== expectedManifestSha256) {
    fail("quote candidate manifest digest mismatch");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  exactKeys(manifest, [
    "formatVersion", "stage", "environment", "purpose", "lkSourceCommit", "phAdminSourceCommit",
    "toolingCommit", "lkOriginMainAtBuild", "phAdminOriginMainAtBuild", "createdAt",
    "components", "files", "capabilities", "authority",
  ], "quote candidate manifest");
  if (manifest.formatVersion !== 1 || manifest.stage !== "LOCAL_QUOTE_ONLY_CANDIDATE"
    || manifest.environment !== "DEV" || manifest.purpose !== PURPOSE
    || manifest.lkSourceCommit !== LK_SOURCE_COMMIT || manifest.phAdminSourceCommit !== PH_ADMIN_SOURCE_COMMIT
    || !COMMIT.test(manifest.toolingCommit) || !COMMIT.test(manifest.lkOriginMainAtBuild)
    || !COMMIT.test(manifest.phAdminOriginMainAtBuild) || !Number.isFinite(Date.parse(manifest.createdAt))) {
    fail("quote candidate identity mismatch");
  }
  exactKeys(manifest.components, [
    "runtimeSha256", "fixtureSha256", "evaluatorSha256", "resolverSha256",
    "resolverRuntimeSha256", "contractSha256", "unitSha256", "resolverCompiler",
  ], "quote candidate components");
  exactKeys(manifest.authority, [
    "hostRead", "hostInstall", "daemonReload", "serviceStart", "enableUnit", "ingress",
    "activation", "canaryIds", "secrets", "providerWrites", "bookingWrites",
    "paymentWrites", "entitlementMutations", "externalWrites",
  ], "quote candidate authority");
  if (JSON.stringify(manifest.components.resolverCompiler) !== JSON.stringify({
    name: "typescript", version: "5.9.3", target: "ES2022", module: "ES2022",
  })) fail("quote candidate resolver compiler identity mismatch");
  if (JSON.stringify(manifest.capabilities) !== JSON.stringify({
    route: `GET ${ROUTE}`, browserAcceptedFields: [], outboundHttp: 0, mongoOperations: [],
    provider: "NOT_INCLUDED", bookingWrites: "NOT_INCLUDED", paymentWrites: "NOT_INCLUDED",
    entitlementMutations: "NOT_INCLUDED", standardManualUat: "BLOCKED",
  }) || Object.values(manifest.authority).some((value) => value !== false)) {
    fail("quote candidate exceeds source-only authority");
  }
  const listed = manifest.files.map((row) => row.path);
  if (JSON.stringify(listed) !== JSON.stringify(EXPECTED_FILES)
    || JSON.stringify(inventory(root)) !== JSON.stringify(["manifest.json", ...EXPECTED_FILES].sort())) {
    fail("quote candidate inventory mismatch");
  }
  for (const row of manifest.files) {
    exactKeys(row, ["path", "mode", "sha256", "size"], `quote file ${row.path}`);
    const bytes = fs.readFileSync(path.join(root, row.path));
    const mode = (fs.lstatSync(path.join(root, row.path)).mode & 0o777).toString(8).padStart(4, "0");
    if (!SHA256.test(row.sha256) || sha256(bytes) !== row.sha256 || bytes.length !== row.size || mode !== row.mode) {
      fail(`quote candidate file mismatch (${row.path})`);
    }
  }
  const byPath = Object.fromEntries(manifest.files.map((row) => [row.path, row]));
  if (manifest.components.runtimeSha256 !== byPath["payload/quote_runtime.mjs"].sha256
    || manifest.components.fixtureSha256 !== byPath["payload/quote_fixture.json"].sha256
    || manifest.components.evaluatorSha256 !== byPath["payload/fn_managed_subscription_policy_evaluate.js"].sha256
    || manifest.components.resolverSha256 !== byPath["payload/subscription-sale-period-resolver.ts"].sha256
    || manifest.components.resolverRuntimeSha256 !== byPath["payload/subscription-sale-period-resolver.mjs"].sha256
    || manifest.components.contractSha256 !== byPath["payload/quote_contract.json"].sha256
    || manifest.components.unitSha256 !== byPath["payload/lk1-subscription-dev-quote.service"].sha256) {
    fail("quote candidate component binding mismatch");
  }
  if (manifest.components.runtimeSha256 !== RUNTIME_SHA256
    || manifest.components.fixtureSha256 !== FIXTURE_SHA256
    || manifest.components.contractSha256 !== CONTRACT_SHA256
    || manifest.components.unitSha256 !== UNIT_SHA256
    || manifest.components.evaluatorSha256 !== EVALUATOR_SHA256
    || manifest.components.resolverSha256 !== RESOLVER_SHA256
    || manifest.components.resolverRuntimeSha256 !== RESOLVER_RUNTIME_SHA256) {
    fail("quote candidate exact source component digest mismatch");
  }
  validateQuoteOnlyContract(JSON.parse(fs.readFileSync(path.join(root, "payload/quote_contract.json"), "utf8")));
  validateQuoteOnlyUnit(fs.readFileSync(path.join(root, "payload/lk1-subscription-dev-quote.service"), "utf8"));
  validateQuoteOnlyRuntime(fs.readFileSync(path.join(root, "payload/quote_runtime.mjs"), "utf8"));
  validateQuoteOnlyResolverRuntime(fs.readFileSync(
    path.join(root, "payload/subscription-sale-period-resolver.mjs"), "utf8",
  ));
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5 || process.argv[2] !== "--bundle" || process.argv[3].startsWith("-") || !process.argv[4].startsWith("--manifest-sha256=")) {
    fail("Usage: verify_lk1_subscription_quote_only_candidate.mjs --bundle <directory> --manifest-sha256=<sha256>");
  }
  const manifest = verifyQuoteOnlyCandidateBundle(process.argv[3], process.argv[4].slice("--manifest-sha256=".length));
  process.stdout.write(`LK1_SUBSCRIPTION_QUOTE_ONLY_CANDIDATE=VERIFIED\ntoolingCommit=${manifest.toolingCommit}\n`);
}

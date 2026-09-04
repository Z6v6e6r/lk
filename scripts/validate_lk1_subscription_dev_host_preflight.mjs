#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const RFC3339_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const INGRESS_TARGET_REFERENCE_PATTERN = "(^|[^0-9])(1882|27030|3037|3038|3039)([^0-9]|$)|lk1-subscription-dev-(mongo|cup|provider-fixture|identity-fixture|nodered)[.]service|/srv/lk1-subscription-dev(?:/|$)";
const EXPECTED_MACHINE_ID_SHA256 = "9f29889b29a55b2c7e1eeb65616d2049b16972589de1bc623a61d38d92dd7ad8";
const EXPECTED_UNITS = Object.freeze([
  "lk1-subscription-dev-mongo.service",
  "lk1-subscription-dev-cup.service",
  "lk1-subscription-dev-provider-fixture.service",
  "lk1-subscription-dev-identity-fixture.service",
  "lk1-subscription-dev-nodered.service",
]);
const fail = (message) => { throw new Error(message); };
const readJson = (relativePath) => JSON.parse(fs.readFileSync(
  new URL(relativePath, import.meta.url),
  "utf8",
));
const CHECKED_PROVISIONING_CONTRACT = Object.freeze(readJson(
  "./lk1_subscription_dev_provisioning_contract.json",
));
const CHECKED_RELEASE_RECEIPT = Object.freeze(readJson(
  "./lk1_subscription_dev_release_receipt_v2_contract.json",
));
const TRUSTED_SHARED_FLOW_SHA256 = CHECKED_PROVISIONING_CONTRACT.evidence.sharedFlowSha256;
const UNIT_SOURCE_PATHS = Object.freeze({
  "lk1-subscription-dev-mongo.service": [
    "./lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-mongo.service",
  ],
  "lk1-subscription-dev-cup.service": [
    "./lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-cup.service",
    "./lk1_subscription_dev_runtime_install/units/lk1-subscription-dev-cup.service",
  ],
  "lk1-subscription-dev-provider-fixture.service": [
    "./lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-provider-fixture.service",
    "./lk1_subscription_dev_runtime_install/units/lk1-subscription-dev-provider-fixture.service",
  ],
  "lk1-subscription-dev-identity-fixture.service": [
    "./lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-identity-fixture.service",
    "./lk1_subscription_dev_runtime_install/units/lk1-subscription-dev-identity-fixture.service",
  ],
  "lk1-subscription-dev-nodered.service": [
    "./lk1_subscription_dev_bootstrap/units/lk1-subscription-dev-nodered.service",
    "./lk1_subscription_dev_runtime_install/units/lk1-subscription-dev-nodered.service",
  ],
});
const TRUSTED_UNIT_FRAGMENT_SHA256 = Object.freeze(Object.fromEntries(
  Object.entries(UNIT_SOURCE_PATHS).map(([unit, sources]) => [unit, Object.freeze(
    [...new Set(sources.map((source) => sha256(fs.readFileSync(new URL(source, import.meta.url)))))],
  )]),
));
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} schema mismatch`);
  }
};

export function validateHostPreflightEvidence(evidence) {
  exactKeys(evidence, [
    "schemaVersion", "environment", "state", "capturedAt", "maximumAgeSeconds", "target",
    "hostCapabilities", "dedicatedUnits", "listeners", "inputs", "sharedResources", "authority",
  ], "host preflight evidence");
  const capturedAt = Date.parse(evidence.capturedAt);
  if (evidence.schemaVersion !== 1 || evidence.environment !== "DEV"
    || evidence.state !== "PASS_AT_CAPTURE" || !RFC3339_SECONDS.test(evidence.capturedAt)
    || !Number.isFinite(capturedAt)
    || evidence.maximumAgeSeconds !== 3600) {
    fail("host preflight evidence has invalid identity");
  }
  exactKeys(evidence.target, ["hostAlias", "hostname", "machineIdSha256"], "host target");
  if (evidence.target.hostAlias !== "lk-reserve-89"
    || evidence.target.hostname !== "89-108-64-209.cloudvps.regruhosting.ru"
    || !SHA256.test(evidence.target.machineIdSha256)
    || evidence.target.machineIdSha256 !== EXPECTED_MACHINE_ID_SHA256) {
    fail("host target identity mismatch");
  }
  exactKeys(evidence.hostCapabilities, [
    "systemdVersion", "minimumRequiredSystemdVersion", "authorizationTransport",
    "authorizationTransportCompatible", "networkIsolationRuntimeVerified", "serviceStartBlocked",
  ], "host capabilities");
  if (evidence.hostCapabilities.systemdVersion !== 245
    || evidence.hostCapabilities.minimumRequiredSystemdVersion !== 245
    || evidence.hostCapabilities.authorizationTransport !== "ROOT_OWNED_GROUP_READ_ONLY_FILE"
    || evidence.hostCapabilities.authorizationTransportCompatible !== true
    || evidence.hostCapabilities.networkIsolationRuntimeVerified !== false
    || evidence.hostCapabilities.serviceStartBlocked !== true) {
    fail("host capabilities do not support the candidate authorization transport");
  }
  if (JSON.stringify(Object.keys(evidence.dedicatedUnits)) !== JSON.stringify(EXPECTED_UNITS)) {
    fail("dedicated unit inventory mismatch");
  }
  for (const [name, state] of Object.entries(evidence.dedicatedUnits)) {
    exactKeys(state, ["loadState", "activeState", "unitFileState"], `unit ${name}`);
    if (state.loadState !== "loaded" || state.activeState !== "inactive"
      || state.unitFileState !== "disabled") fail(`unit ${name} is not stopped and disabled`);
  }
  exactKeys(evidence.listeners, [
    "sharedNodeRed1880Present", "forbiddenSharedCup3036Present", "reserved1882Absent",
    "reserved27030Absent", "reserved3037Absent", "reserved3038Absent", "reserved3039Absent",
  ], "listener evidence");
  if (Object.entries(evidence.listeners).some(([key, value]) => (
    key.endsWith("Absent") ? value !== true : value !== true
  ))) fail("listener isolation evidence mismatch");
  exactKeys(evidence.inputs, [
    "targetFlowAbsent", "fixtureConfigAbsent", "releaseReceiptAbsent",
    "serviceStartAuthorizationAbsent", "installIdentityEnvironmentAbsent", "tlsKeyAbsent",
    "tlsCertificateAbsent", "productionMarkersAbsent",
  ], "authorization inputs");
  if (Object.values(evidence.inputs).some((value) => value !== true)) {
    fail("host authorization inputs are not absent");
  }
  exactKeys(evidence.sharedResources, ["flowSha256", "expectedFlowSha256", "unchanged"], "shared resources");
  if (!SHA256.test(evidence.sharedResources.flowSha256)
    || evidence.sharedResources.expectedFlowSha256 !== TRUSTED_SHARED_FLOW_SHA256
    || evidence.sharedResources.flowSha256 !== evidence.sharedResources.expectedFlowSha256
    || evidence.sharedResources.unchanged !== true) fail("shared resources drifted");
  exactKeys(evidence.authority, [
    "hostRead", "hostInstall", "daemonReload", "serviceStart", "externalWrites",
  ], "preflight authority");
  if (evidence.authority.hostRead !== true
    || Object.entries(evidence.authority).some(([key, value]) => key !== "hostRead" && value !== false)) {
    fail("preflight exceeded read-only authority");
  }
  return true;
}

const checkedReleaseBinding = Object.freeze({
  sourceCommit: CHECKED_RELEASE_RECEIPT.sourceCommit,
  sourceFlowSha256: CHECKED_RELEASE_RECEIPT.sourceFlowSha256,
  candidateSha256: CHECKED_RELEASE_RECEIPT.candidateSha256,
  manifestSha256: CHECKED_RELEASE_RECEIPT.manifestSha256,
});

const exactObject = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} mismatch`);
};

export function validateFreshHostPreflightEvidence(evidence, now, {
  expectedRepositoryIdentity = readCurrentRepositoryIdentity(),
  expectedReleaseBinding = checkedReleaseBinding,
  expectedValidatorSha256 = currentCaptureIdentity().validatorSha256,
  expectedRemoteScriptSha256 = currentCaptureIdentity().remoteScriptSha256,
} = {}) {
  const archiveShape = {
    ...evidence,
    schemaVersion: 1,
  };
  delete archiveShape.repositoryIdentity;
  delete archiveShape.releaseBinding;
  delete archiveShape.capture;
  delete archiveShape.runtimeIsolation;
  validateHostPreflightEvidence(archiveShape);
  if (evidence.schemaVersion !== 2) fail("fresh host preflight evidence schema mismatch");
  exactKeys(evidence, [
    "schemaVersion", "environment", "state", "capturedAt", "maximumAgeSeconds", "target",
    "hostCapabilities", "dedicatedUnits", "listeners", "inputs", "sharedResources", "authority",
    "repositoryIdentity", "releaseBinding", "capture", "runtimeIsolation",
  ], "fresh host preflight evidence");
  exactKeys(evidence.runtimeIsolation, ["systemdUnits", "ingress"], "fresh runtime isolation");
  if (JSON.stringify(Object.keys(evidence.runtimeIsolation.systemdUnits)) !== JSON.stringify(EXPECTED_UNITS)) {
    fail("fresh systemd isolation inventory mismatch");
  }
  for (const [unit, isolation] of Object.entries(evidence.runtimeIsolation.systemdUnits)) {
    exactKeys(isolation, [
      "fragmentSha256", "fragmentReadable", "dropInsAbsent", "effectiveProductionMarkersAbsent",
    ], `fresh unit isolation ${unit}`);
    if (!TRUSTED_UNIT_FRAGMENT_SHA256[unit]?.includes(isolation.fragmentSha256)
      || isolation.fragmentReadable !== true || isolation.dropInsAbsent !== true
      || isolation.effectiveProductionMarkersAbsent !== true) {
      fail(`fresh unit isolation mismatch (${unit})`);
    }
  }
  exactKeys(evidence.runtimeIsolation.ingress, [
    "configurationReadable", "targetRouteAbsent",
  ], "fresh ingress isolation");
  if (evidence.runtimeIsolation.ingress.configurationReadable !== true
    || evidence.runtimeIsolation.ingress.targetRouteAbsent !== true) {
    fail("fresh ingress isolation mismatch");
  }
  exactKeys(evidence.repositoryIdentity, ["headSha", "treeSha", "clean"], "repository identity");
  if (!expectedRepositoryIdentity) fail("fresh repository identity is required");
  exactObject(evidence.repositoryIdentity, expectedRepositoryIdentity, "fresh repository identity");
  if (!GIT_SHA.test(evidence.repositoryIdentity.headSha)
    || !GIT_SHA.test(evidence.repositoryIdentity.treeSha)
    || evidence.repositoryIdentity.clean !== true) {
    fail("fresh repository identity is invalid or dirty");
  }
  exactKeys(evidence.releaseBinding, [
    "sourceCommit", "sourceFlowSha256", "candidateSha256", "manifestSha256",
  ], "fresh release binding");
  exactObject(evidence.releaseBinding, expectedReleaseBinding, "fresh release binding");
  exactKeys(evidence.capture, [
    "transport", "validatorPath", "validatorSha256", "remoteScriptSha256",
  ], "fresh capture identity");
  if (evidence.capture.transport !== "SSH_BATCH_ROOT_READ_ONLY"
    || evidence.capture.validatorPath !== "scripts/validate_lk1_subscription_dev_host_preflight.mjs"
    || evidence.capture.validatorSha256 !== expectedValidatorSha256
    || evidence.capture.remoteScriptSha256 !== expectedRemoteScriptSha256
    || !SHA256.test(evidence.capture.validatorSha256)
    || !SHA256.test(evidence.capture.remoteScriptSha256)) {
    fail("fresh capture tooling identity mismatch");
  }
  const capturedAt = Date.parse(evidence.capturedAt);
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs) || capturedAt > nowMs
    || nowMs - capturedAt > evidence.maximumAgeSeconds * 1000) {
    fail("host preflight evidence is stale or has invalid freshness clock");
  }
  return true;
}

export const checkedHostPreflightEvidence = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_host_preflight_evidence.json", import.meta.url),
  "utf8",
)));

const HOST_ALIAS = "lk-reserve-89";
const REMOTE_PREFLIGHT_SCRIPT = `set -euo pipefail
test "$(id -u)" = 0
printf 'HOSTNAME\\t%s\\n' "$(hostname)"
printf 'MACHINE_ID_SHA256\\t%s\\n' "$(sha256sum /etc/machine-id | awk '{print $1}')"
printf 'SYSTEMD_VERSION\\t%s\\n' "$(systemctl --version | awk 'NR == 1 {print $2}')"
for unit in \\
  lk1-subscription-dev-mongo.service \\
  lk1-subscription-dev-cup.service \\
  lk1-subscription-dev-provider-fixture.service \\
  lk1-subscription-dev-identity-fixture.service \\
  lk1-subscription-dev-nodered.service; do
  printf 'UNIT\\t%s\\t%s\\t%s\\t%s\\n' "$unit" \\
    "$(systemctl show "$unit" -p LoadState --value)" \\
    "$(systemctl show "$unit" -p ActiveState --value)" \\
    "$(systemctl show "$unit" -p UnitFileState --value)"
done
for port in 1880 3036 1882 27030 3037 3038 3039; do
  if ss -H -ltn "sport = :$port" | grep -q .; then state=PRESENT; else state=ABSENT; fi
  printf 'LISTENER\\t%s\\t%s\\n' "$port" "$state"
done
for row in \\
  'targetFlowAbsent:/srv/lk1-subscription-dev/node-red/flows.json' \\
  'fixtureConfigAbsent:/srv/lk1-subscription-dev/private/fixture.json' \\
  'releaseReceiptAbsent:/srv/lk1-subscription-dev/node-red/release-identity.json' \\
  'serviceStartAuthorizationAbsent:/srv/lk1-subscription-dev/authorization/service-start.approved' \\
  'installIdentityEnvironmentAbsent:/srv/lk1-subscription-dev/runtime/install-identity.env' \\
  'tlsKeyAbsent:/srv/lk1-subscription-dev/tls/server.key' \\
  'tlsCertificateAbsent:/srv/lk1-subscription-dev/tls/server.crt'; do
  key="\${row%%:*}"
  target="\${row#*:}"
  if test -e "$target"; then state=false; else state=true; fi
  printf 'INPUT\\t%s\\t%s\\n' "$key" "$state"
done
production_markers_absent=true
for unit in \\
  lk1-subscription-dev-mongo.service \\
  lk1-subscription-dev-cup.service \\
  lk1-subscription-dev-provider-fixture.service \\
  lk1-subscription-dev-identity-fixture.service \\
  lk1-subscription-dev-nodered.service; do
  fragment="$(systemctl show "$unit" -p FragmentPath --value)"
  fragment_readable=false
  fragment_sha256=INVALID
  if test -n "$fragment" && test -f "$fragment" && test -r "$fragment"; then
    fragment_readable=true
    fragment_sha256="$(sha256sum "$fragment" | awk '{print $1}')"
  fi
  drop_ins="$(systemctl show "$unit" -p DropInPaths --value)"
  if test -z "$drop_ins"; then drop_ins_absent=true; else drop_ins_absent=false; fi
  effective="$(systemctl show "$unit" -p ExecStart -p Environment -p EnvironmentFiles -p User -p Group -p IPAddressAllow -p IPAddressDeny -p RestrictAddressFamilies)"
  if printf '%s\\n' "$effective" | grep -Eiq 'lk-primary-147|padlhub[.](su|ru)|vivacrm|mongodb[+]srv|127[.]0[.]0[.]1:(3036|27029)|0[.]0[.]0[.]0'; then
    effective_markers_absent=false
  else
    effective_markers_absent=true
  fi
  if test "$fragment_readable" != true || test "$drop_ins_absent" != true || test "$effective_markers_absent" != true; then
    production_markers_absent=false
  fi
  printf 'UNIT_ISOLATION\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$unit" "$fragment_sha256" \
    "$fragment_readable" "$drop_ins_absent" "$effective_markers_absent"
done
ingress_configuration_readable=true
ingress_target_absent=true
for root in /etc/nginx /etc/caddy /etc/haproxy; do
  if test -d "$root"; then
    if find "$root" -type f ! -readable -print -quit | grep -q .; then
      ingress_configuration_readable=false
    fi
    if grep -RIsEq '${INGRESS_TARGET_REFERENCE_PATTERN}' "$root"; then
      ingress_target_absent=false
    fi
  fi
done
if command -v nginx >/dev/null 2>&1; then
  if nginx_effective="$(nginx -T 2>&1)"; then
    if printf '%s\\n' "$nginx_effective" | grep -Eiq '${INGRESS_TARGET_REFERENCE_PATTERN}'; then
      ingress_target_absent=false
    fi
  else
    ingress_configuration_readable=false
  fi
fi
if test "$ingress_configuration_readable" != true || test "$ingress_target_absent" != true; then
  production_markers_absent=false
fi
printf 'INGRESS_ISOLATION\\t%s\\t%s\\n' "$ingress_configuration_readable" "$ingress_target_absent"
printf 'PRODUCTION_MARKERS_ABSENT\\t%s\\n' "$production_markers_absent"
printf 'SHARED_FLOW_SHA256\\t%s\\n' "$(sha256sum /root/.node-red/flows.json | awk '{print $1}')"
printf 'END\\n'
`;

const VALIDATOR_PATH = fileURLToPath(import.meta.url);
const currentCaptureIdentity = () => ({
  validatorPath: "scripts/validate_lk1_subscription_dev_host_preflight.mjs",
  validatorSha256: sha256(fs.readFileSync(VALIDATOR_PATH)),
  remoteScriptSha256: sha256(REMOTE_PREFLIGHT_SCRIPT),
});

const readCurrentRepositoryIdentity = () => {
  const gitOptions = {
    cwd: path.dirname(VALIDATOR_PATH), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  };
  const git = (...args) => execFileSync("git", args, gitOptions).trim();
  let trackedBytesMatchHead = true;
  try {
    execFileSync("git", ["diff", "--quiet", "HEAD", "--"], gitOptions);
  } catch {
    trackedBytesMatchHead = false;
  }
  const hasHiddenIndexFlags = git("ls-files", "-v").split("\n")
    .some((line) => /^[a-zS] /.test(line));
  return {
    headSha: git("rev-parse", "HEAD"),
    treeSha: git("rev-parse", "HEAD^{tree}"),
    clean: git("status", "--porcelain", "--untracked-files=all") === ""
      && trackedBytesMatchHead && !hasHiddenIndexFlags,
  };
};

const defaultRunSsh = (script) => execFileSync(
  "/usr/bin/ssh",
  ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", HOST_ALIAS, "bash", "-s"],
  {
    input: script,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  },
);

export function captureCurrentHostPreflightEvidence({
  runSsh = defaultRunSsh,
  now = new Date(),
  readRepositoryIdentity = readCurrentRepositoryIdentity,
} = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("host preflight capture inputs are invalid");
  }
  const repositoryIdentityBefore = readRepositoryIdentity();
  if (repositoryIdentityBefore.clean !== true) fail("host preflight capture requires a clean repository");
  const captureIdentity = currentCaptureIdentity();
  const lines = String(runSsh(REMOTE_PREFLIGHT_SCRIPT)).trim().split("\n");
  const repositoryIdentityAfter = readRepositoryIdentity();
  exactObject(repositoryIdentityAfter, repositoryIdentityBefore, "repository identity during capture");
  const scalar = new Map();
  const units = {};
  const listeners = new Map();
  const inputs = {};
  const unitIsolation = {};
  let ingressIsolation;
  let ended = false;
  for (const [lineIndex, line] of lines.entries()) {
    const fields = line.split("\t");
    const kind = fields[0];
    if (kind === "UNIT" && fields.length === 5 && EXPECTED_UNITS.includes(fields[1])) {
      if (units[fields[1]]) fail("duplicate host preflight unit evidence");
      units[fields[1]] = {
        loadState: fields[2], activeState: fields[3], unitFileState: fields[4],
      };
    } else if (kind === "LISTENER" && fields.length === 3) {
      if (listeners.has(fields[1])) fail("duplicate host preflight listener evidence");
      listeners.set(fields[1], fields[2]);
    } else if (kind === "INPUT" && fields.length === 3) {
      if (Object.hasOwn(inputs, fields[1])) fail("duplicate host preflight input evidence");
      inputs[fields[1]] = fields[2] === "true";
    } else if (kind === "UNIT_ISOLATION" && fields.length === 6
      && EXPECTED_UNITS.includes(fields[1])) {
      if (unitIsolation[fields[1]]) fail("duplicate host preflight unit isolation evidence");
      unitIsolation[fields[1]] = {
        fragmentSha256: fields[2],
        fragmentReadable: fields[3] === "true",
        dropInsAbsent: fields[4] === "true",
        effectiveProductionMarkersAbsent: fields[5] === "true",
      };
    } else if (kind === "INGRESS_ISOLATION" && fields.length === 3 && !ingressIsolation) {
      ingressIsolation = {
        configurationReadable: fields[1] === "true",
        targetRouteAbsent: fields[2] === "true",
      };
    } else if (kind === "END" && fields.length === 1 && lineIndex === lines.length - 1) {
      ended = true;
    } else if (["HOSTNAME", "MACHINE_ID_SHA256", "SYSTEMD_VERSION",
      "PRODUCTION_MARKERS_ABSENT", "SHARED_FLOW_SHA256"].includes(kind)
      && fields.length === 2 && !scalar.has(kind)) {
      scalar.set(kind, fields[1]);
    } else {
      fail("host preflight SSH transcript schema mismatch");
    }
  }
  if (!ended || scalar.size !== 5 || Object.keys(units).length !== EXPECTED_UNITS.length
    || listeners.size !== 7 || Object.keys(inputs).length !== 7
    || Object.keys(unitIsolation).length !== EXPECTED_UNITS.length || !ingressIsolation) {
    fail("host preflight SSH transcript is incomplete");
  }
  const flowSha256 = scalar.get("SHARED_FLOW_SHA256");
  const evidence = {
    schemaVersion: 2,
    environment: "DEV",
    state: "PASS_AT_CAPTURE",
    capturedAt: now.toISOString(),
    maximumAgeSeconds: 3600,
    target: {
      hostAlias: HOST_ALIAS,
      hostname: scalar.get("HOSTNAME"),
      machineIdSha256: scalar.get("MACHINE_ID_SHA256"),
    },
    hostCapabilities: {
      systemdVersion: Number.parseInt(scalar.get("SYSTEMD_VERSION"), 10),
      minimumRequiredSystemdVersion: 245,
      authorizationTransport: "ROOT_OWNED_GROUP_READ_ONLY_FILE",
      authorizationTransportCompatible: Number.parseInt(scalar.get("SYSTEMD_VERSION"), 10) === 245,
      networkIsolationRuntimeVerified: false,
      serviceStartBlocked: true,
    },
    dedicatedUnits: Object.fromEntries(EXPECTED_UNITS.map((unit) => [unit, units[unit]])),
    listeners: {
      sharedNodeRed1880Present: listeners.get("1880") === "PRESENT",
      forbiddenSharedCup3036Present: listeners.get("3036") === "PRESENT",
      reserved1882Absent: listeners.get("1882") === "ABSENT",
      reserved27030Absent: listeners.get("27030") === "ABSENT",
      reserved3037Absent: listeners.get("3037") === "ABSENT",
      reserved3038Absent: listeners.get("3038") === "ABSENT",
      reserved3039Absent: listeners.get("3039") === "ABSENT",
    },
    inputs: {
      targetFlowAbsent: inputs.targetFlowAbsent === true,
      fixtureConfigAbsent: inputs.fixtureConfigAbsent === true,
      releaseReceiptAbsent: inputs.releaseReceiptAbsent === true,
      serviceStartAuthorizationAbsent: inputs.serviceStartAuthorizationAbsent === true,
      installIdentityEnvironmentAbsent: inputs.installIdentityEnvironmentAbsent === true,
      tlsKeyAbsent: inputs.tlsKeyAbsent === true,
      tlsCertificateAbsent: inputs.tlsCertificateAbsent === true,
      productionMarkersAbsent: scalar.get("PRODUCTION_MARKERS_ABSENT") === "true",
    },
    sharedResources: {
      flowSha256,
      expectedFlowSha256: TRUSTED_SHARED_FLOW_SHA256,
      unchanged: flowSha256 === TRUSTED_SHARED_FLOW_SHA256,
    },
    authority: {
      hostRead: true,
      hostInstall: false,
      daemonReload: false,
      serviceStart: false,
      externalWrites: false,
    },
    repositoryIdentity: repositoryIdentityAfter,
    releaseBinding: checkedReleaseBinding,
    capture: {
      transport: "SSH_BATCH_ROOT_READ_ONLY",
      ...captureIdentity,
    },
    runtimeIsolation: {
      systemdUnits: Object.fromEntries(EXPECTED_UNITS.map((unit) => [unit, unitIsolation[unit]])),
      ingress: ingressIsolation,
    },
  };
  validateFreshHostPreflightEvidence(evidence, now, {
    expectedRepositoryIdentity: repositoryIdentityAfter,
    expectedValidatorSha256: captureIdentity.validatorSha256,
    expectedRemoteScriptSha256: captureIdentity.remoteScriptSha256,
  });
  return evidence;
}

export function writeFreshHostPreflightEvidence(evidence, { temporaryRoot = os.tmpdir() } = {}) {
  const parent = fs.realpathSync(temporaryRoot);
  const allowedRoots = [...new Set(["/private/tmp", "/tmp", os.tmpdir()])]
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  if (!allowedRoots.includes(parent)) {
    fail("host preflight output root must be an approved temporary directory");
  }
  const directory = fs.mkdtempSync(path.join(parent, "lk1-dev-host-preflight-"));
  fs.chmodSync(directory, 0o700);
  const outputPath = path.join(directory, "evidence.json");
  const fd = fs.openSync(outputPath, fs.constants.O_CREAT | fs.constants.O_EXCL
    | fs.constants.O_WRONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW, 0o600);
  let before;
  try {
    before = fs.fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600
      || before.nlink !== 1) fail("host preflight output file custody mismatch");
    fs.writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const after = fs.lstatSync(outputPath);
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino
    || after.uid !== process.getuid() || (after.mode & 0o777) !== 0o600 || after.nlink !== 1) {
    fail("host preflight output path changed during write");
  }
  return outputPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--capture-via-ssh") {
    fail("Usage: validate_lk1_subscription_dev_host_preflight.mjs --capture-via-ssh");
  }
  const freshEvidence = captureCurrentHostPreflightEvidence();
  const outputPath = writeFreshHostPreflightEvidence(freshEvidence);
  process.stdout.write(`LK1_DEV_HOST_PREFLIGHT=PASS_CURRENT\nEVIDENCE_PATH=${outputPath}\n`);
}

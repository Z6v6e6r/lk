import assert from "node:assert/strict";

// CI fixture contract only. Provisioning and workflow activation require B's frozen handoff.
export const admissionTask = "b1-booked-operation-admission-20261006";
export const admissionCiImages = {
  mongo: "mongo@sha256:a3ba70fe8da14d155e158245fc89a9dd6adf92ae34976ebce24464a3c1573c78",
  pg: "postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
};
const postgresAmd64Manifest = "sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551";
const helperPath = "scripts/b1-booked-operation-admission-rehearsal.ts";
const digest = /^sha256:(?!0{64}$)[a-f0-9]{64}$/;
const sha = /^(?!0{40}$)[a-f0-9]{40}$/;
const memory = 512 * 1024 * 1024;
const tmpfs = { "/tmp": "rw,noexec,nosuid,nodev,size=67108864" };

function normalizedImage(reference) {
  return reference.replace(/^docker\.io\/library\//, "");
}

export function createAdmissionCiContract(input) {
  for (const key of ["lk1Head", "lk1AdmissionHead", "lk1MoneyHead", "lk1OwnerCiHead", "lk2Head", "helperBlob"])
    assert.match(input[key] ?? "", sha, `${key} must be a full immutable Git object ID`);
  assert.match(String(input.runId ?? ""), /^[1-9][0-9]{0,19}$/);
  assert.match(String(input.runAttempt ?? ""), /^[1-9][0-9]{0,5}$/);
  assert.match(input.ownerNonce ?? "", /^[a-f0-9]{32}$/);
  assert.equal(input.platform, "linux/amd64");
  assert.equal(input.nodeMajor, 22);
  const owner = `${input.runId}-${input.runAttempt}-${input.ownerNonce}`;
  const labels = {
    "padlhub.task": admissionTask, "padlhub.ci-run": String(input.runId),
    "padlhub.ci-attempt": String(input.runAttempt), "padlhub.ci.owner": owner,
  };
  const fixtures = {};
  for (const [kind, repository, hostPort, containerPort, suffixes] of [
    ["mongo", "mongo", "27039", "27017/tcp", ["data", "configdb"]],
    ["pg", "postgres", "55439", "5432/tcp", ["data"]],
  ]) {
    const pin = input.images?.[kind];
    assert.match(pin?.reference ?? "", new RegExp(`^(?:docker\\.io/library/)?${repository}@sha256:(?!0{64}$)[a-f0-9]{64}$`));
    assert.equal(normalizedImage(pin.reference), admissionCiImages[kind]);
    // Docker Engine may expose an index, manifest or config ID here. Record the
    // ID of the validated pinned linux/amd64 image; do not assume its digest type.
    assert.match(pin?.imageId ?? "", digest, `${kind} needs its validated runner image ID`);
    // Match B's sole fixture protocol. Refuse collisions before creating these
    // fixed names, including resources left by an earlier attempt of this job.
    const name = `b1-admission-${kind}-20261006`;
    fixtures[kind] = {
      name, image: pin.reference, imageId: pin.imageId,
      hostPort, containerPort, labels: { ...labels },
      volumes: suffixes.map((suffix) => `${name}-${suffix}`),
      memory, nanoCpus: 1_000_000_000, pidsLimit: 128, tmpfs: { ...tmpfs },
    };
  }
  return {
    version: 1, task: admissionTask, owner, helperPath,
    source: Object.fromEntries(["lk1Head", "lk1AdmissionHead", "lk1MoneyHead", "lk1OwnerCiHead", "lk2Head", "helperBlob"].map((key) => [key, input[key]])),
    platform: input.platform, nodeMajor: input.nodeMajor, fixtures,
    required: "1", migrationAcknowledgement: "CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1",
    testPath: "scripts/tests/bookedOperationAdmission.mongo.test.mjs",
    fixtureDiskBudgetBytes: 2 * 1024 ** 3, freeFloorBytes: 5 * 1024 ** 3,
  };
}

export function assertAdmissionRunnerEnvironment(contract, evidence) {
  assert.equal(evidence.githubActions, "true");
  assert.equal(evidence.runId, contract.fixtures.pg.labels["padlhub.ci-run"]);
  assert.equal(evidence.runAttempt, contract.fixtures.pg.labels["padlhub.ci-attempt"]);
  assert.equal(evidence.platform, "linux");
  assert.equal(evidence.arch, "x64");
  assert.equal(evidence.nodeMajor, 22);
  assert.equal(evidence.dockerReachable, true);
  assert.ok(evidence.freeBytes >= contract.freeFloorBytes);
}

export function assertAdmissionResourcesAbsent(evidence) {
  assert.deepEqual(evidence.containers, []);
  assert.deepEqual(evidence.volumes, []);
  assert.deepEqual(evidence.loopbackListeners, []);
}

export function assertAdmissionCheckout(contract, evidence) {
  for (const key of ["lk1Head", "lk2Head", "helperBlob"])
    assert.equal(evidence[key], contract.source[key], `${key} checkout drift`);
  assert.equal(evidence.lk1AdmissionAncestor, true);
  assert.equal(evidence.lk1MoneyAncestor, true);
  assert.equal(evidence.lk1OwnerCiAncestor, true);
  assert.equal(evidence.lk1TrackedClean, true);
  assert.equal(evidence.lk2TrackedClean, true);
  assert.equal(evidence.lk2Detached, true);
  assert.equal(evidence.helperPath, contract.helperPath);
  assert.equal(evidence.lockInstall, "npm ci --include=optional --no-audit --no-fund");
  assert.equal(evidence.installExitCode, 0);
  assert.deepEqual(evidence.packageBuild, ["contracts:generate", "build:packages"]);
  assert.equal(evidence.generationExitCode, 0);
  assert.equal(evidence.packageBuildExitCode, 0);
  assert.equal(evidence.emptyDatabaseVerified, true);
  assert.equal(evidence.migrationAcknowledgement, contract.migrationAcknowledgement);
  assert.equal(evidence.migrationExitCode, 0);
  assert.equal(evidence.migrationLedgerMatches, true);
}

export function assertAdmissionImage(contract, kind, image) {
  const fixture = contract.fixtures[kind];
  assert.ok(fixture, "unknown fixture");
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  assert.equal(image.Id, fixture.imageId);
  assert.ok(image.RepoDigests?.some((reference) => normalizedImage(reference) === normalizedImage(fixture.image)),
    "pulled image must carry the exact official pinned manifest digest");
}

export function assertAdmissionRegistryDescriptor(contract, kind, descriptor) {
  const fixture = contract.fixtures[kind];
  assert.ok(fixture, "unknown fixture");
  assert.equal(descriptor.digest, fixture.image.split("@")[1]);
  if (kind === "pg") {
    assert.equal(descriptor.mediaType, "application/vnd.oci.image.index.v1+json");
    const amd64 = descriptor.manifests.filter((manifest) => manifest.platform?.os === "linux" && manifest.platform?.architecture === "amd64");
    assert.equal(amd64.length, 1);
    assert.equal(amd64[0].digest, postgresAmd64Manifest);
    assert.equal(amd64[0].mediaType, "application/vnd.oci.image.manifest.v1+json");
  } else {
    assert.equal(descriptor.mediaType, "application/vnd.oci.image.manifest.v1+json");
  }
}

export function assertAdmissionContainer(contract, kind, container, volumes) {
  const fixture = contract.fixtures[kind];
  assert.ok(fixture, "unknown fixture");
  assert.match(container.Id ?? "", /^[a-f0-9]{64}$/);
  assert.equal(container.Name, `/${fixture.name}`);
  assert.equal(container.Image, fixture.imageId);
  assert.equal(container.Config.Image, fixture.image);
  for (const [key, value] of Object.entries(fixture.labels)) assert.equal(container.Config.Labels?.[key], value);
  assert.equal(container.State.Running, true);
  assert.equal(container.State.OOMKilled, false);
  const host = container.HostConfig;
  assert.equal(host.Privileged, false);
  assert.equal(host.NetworkMode, "bridge");
  assert.equal(host.AutoRemove, false);
  assert.equal(host.RestartPolicy?.Name, "no");
  assert.deepEqual(host.CapAdd ?? [], []);
  assert.equal(host.Memory, fixture.memory);
  assert.equal(host.NanoCpus, fixture.nanoCpus);
  assert.equal(host.PidsLimit, fixture.pidsLimit);
  assert.deepEqual(host.Tmpfs, fixture.tmpfs);
  assert.ok(host.SecurityOpt?.includes("no-new-privileges"));
  assert.deepEqual(host.PortBindings, { [fixture.containerPort]: [{ HostIp: "127.0.0.1", HostPort: fixture.hostPort }] });
  assert.deepEqual(container.Mounts.map((mount) => mount.Name).sort(), [...fixture.volumes].sort());
  assert.ok(container.Mounts.every((mount) => mount.Type === "volume" && mount.RW === true));
  assert.deepEqual(volumes.map((volume) => volume.Name).sort(), [...fixture.volumes].sort());
  for (const volume of volumes) {
    assert.equal(volume.Driver, "local");
    assert.deepEqual(volume.Options ?? {}, {});
    for (const [key, value] of Object.entries(fixture.labels)) assert.equal(volume.Labels?.[key], value);
  }
  return container.Id; // Cleanup must use this verified ID, with a fresh ownership readback.
}

export function assertAdmissionCleanupIdentity(contract, kind, expectedId, container, volumes) {
  const fixture = contract.fixtures[kind];
  assert.ok(fixture, "unknown fixture");
  assert.match(expectedId, /^[a-f0-9]{64}$/);
  assert.equal(container.Id, expectedId);
  assert.equal(container.Name, `/${fixture.name}`);
  assert.equal(container.Image, fixture.imageId);
  assert.equal(container.Config.Image, fixture.image);
  for (const [key, value] of Object.entries(fixture.labels)) assert.equal(container.Config.Labels?.[key], value);
  assert.deepEqual(volumes.map((volume) => volume.Name).sort(), [...fixture.volumes].sort());
  for (const volume of volumes) {
    assert.equal(volume.Driver, "local");
    assert.deepEqual(volume.Options ?? {}, {});
    for (const [key, value] of Object.entries(fixture.labels)) assert.equal(volume.Labels?.[key], value);
  }
  return expectedId; // Stopped own containers are removable; foreign/replaced IDs are not.
}

export function assertAdmissionPhysicalProof(tap, exitCode) {
  assert.equal(exitCode, 0, "physical test failed or timed out");
  assert.doesNotMatch(tap, /postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\/|Bearer\s|PRIVATE KEY|password/i,
    "credential-bearing test output must never become a public CI proof");
  for (const [key, expected] of [["tests", 1], ["pass", 1], ["fail", 0], ["cancelled", 0], ["skipped", 0], ["todo", 0]]) {
    const matches = [...tap.matchAll(new RegExp(`^# ${key} ([0-9]+)$`, "gm"))];
    assert.equal(matches.length, 1, `missing or ambiguous TAP ${key}`);
    assert.equal(Number(matches[0][1]), expected, `physical TAP ${key} mismatch`);
  }
  const proofs = tap.split("\n").filter((line) => line.startsWith('# {"proof":'))
    .map((line) => JSON.parse(line.slice(2)))
    .filter((proof) => proof.proof === "LOCAL_PHYSICAL_AUTH_PG_MONGO_B1");
  assert.equal(proofs.length, 1, "physical admission proof must occur exactly once");
  assert.deepEqual(proofs[0], {
    proof: "LOCAL_PHYSICAL_AUTH_PG_MONGO_B1", ownerRecords: 4,
    providerWrites: 0, ownerUpdates: 0, sourcePath: true,
  });
  return { physicalTests: 1, skipped: 0, providerWrites: 0 };
}

export function assertAdmissionCleanup(contract, evidence) {
  assert.equal(evidence.owner, contract.owner);
  assert.deepEqual(evidence.containers, []);
  assert.deepEqual(evidence.volumes, []);
  assert.deepEqual(evidence.loopbackListeners, []);
  assert.deepEqual(evidence.taskNetworks, []);
  assert.deepEqual(evidence.childProcesses, []);
  assert.equal(evidence.temporaryArtifactsRemoved, true);
  assert.ok(Number.isSafeInteger(evidence.freeBeforeBytes) && evidence.freeBeforeBytes >= contract.freeFloorBytes);
  assert.ok(Number.isSafeInteger(evidence.minSampledFreeBytes) && evidence.minSampledFreeBytes >= contract.freeFloorBytes);
  assert.ok(Number.isSafeInteger(evidence.freeAfterBytes) && evidence.freeAfterBytes >= contract.freeFloorBytes);
  assert.ok(Number.isSafeInteger(evidence.fixtureBytes) && evidence.fixtureBytes >= 0 && evidence.fixtureBytes <= contract.fixtureDiskBudgetBytes);
  assert.equal(evidence.fixtureDiskBudgetExceeded, false);
}

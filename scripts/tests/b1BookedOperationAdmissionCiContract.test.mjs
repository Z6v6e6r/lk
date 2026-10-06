import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanupAdmissionFixtures, linuxProcessIdentity, sameOwnedProcess } from "../runB1BookedOperationAdmissionCi.mjs";
import {
  admissionCiImages, createAdmissionCiContract, assertAdmissionCheckout, assertAdmissionImage,
  assertAdmissionRunnerEnvironment, assertAdmissionResourcesAbsent,
  assertAdmissionRegistryDescriptor, assertAdmissionCleanupIdentity,
  assertAdmissionContainer, assertAdmissionPhysicalProof, assertAdmissionCleanup,
} from "../b1BookedOperationAdmissionCiContract.mjs";

const input = () => ({
  lk1Head: "a".repeat(40), lk1AdmissionHead: "b".repeat(40), lk1MoneyHead: "c".repeat(40),
  lk2Head: "d".repeat(40), helperBlob: "e".repeat(40),
  lk1OwnerCiHead: "f".repeat(40),
  runId: "12345", runAttempt: "2", ownerNonce: "f".repeat(32), platform: "linux/amd64", nodeMajor: 22,
  images: {
    mongo: { reference: admissionCiImages.mongo, imageId: `sha256:${"b".repeat(64)}` },
    pg: { reference: admissionCiImages.pg, imageId: `sha256:${"d".repeat(64)}` },
  },
});
const contract = () => createAdmissionCiContract(input());
const rejectsMutations = (valid, validate, mutations) => {
  validate(valid);
  for (const mutate of mutations) {
    const changed = structuredClone(valid);
    mutate(changed);
    assert.throws(() => validate(changed), assert.AssertionError);
  }
};

test("CI contract rejects floating source, platform and image identity before provisioning", () => {
  const mutations = [];
  for (const key of ["lk1Head", "lk1AdmissionHead", "lk1MoneyHead", "lk1OwnerCiHead", "lk2Head", "helperBlob"])
    for (const value of [undefined, "main", "a".repeat(7), "0".repeat(40)]) mutations.push((i) => { i[key] = value; });
  for (const kind of ["mongo", "pg"])
    for (const value of ["latest", "postgres:16-alpine", `other@sha256:${"a".repeat(64)}`, `mongo@sha256:${"0".repeat(64)}`])
      mutations.push((i) => { i.images[kind].reference = value; });
  mutations.push((i) => { i.images.mongo.imageId = undefined; }, (i) => { i.platform = "linux/arm64"; },
    (i) => { i.nodeMajor = 25; }, (i) => { i.runId = "../foreign"; }, (i) => { i.runAttempt = "0"; },
    (i) => { i.ownerNonce = ""; });
  rejectsMutations(input(), createAdmissionCiContract, mutations);
});

test("B fixed resource names are retained with distinct custody; public contract contains no credentials", () => {
  const a = contract(); const bInput = input(); bInput.runAttempt = "3";
  const b = createAdmissionCiContract(bInput);
  assert.equal(a.fixtures.mongo.name, "b1-admission-mongo-20261006");
  assert.equal(a.fixtures.pg.volumes[0], "b1-admission-pg-20261006-data");
  assert.notEqual(a.fixtures.mongo.labels["padlhub.ci.owner"], b.fixtures.mongo.labels["padlhub.ci.owner"]);
  assert.equal(a.fixtures.mongo.labels["padlhub.ci-run"], "12345");
  assert.equal(a.required, "1");
  assert.doesNotMatch(JSON.stringify(a), /password|postgresql:\/\/|mongodb:\/\/|PRIVATE KEY/);
});

test("physical runner refuses the local Mac, mismatched run identity and insufficient disk", () => {
  const c = contract();
  rejectsMutations({ githubActions: "true", runId: "12345", runAttempt: "2", platform: "linux", arch: "x64", nodeMajor: 22,
    dockerReachable: true, freeBytes: c.freeFloorBytes }, (e) => assertAdmissionRunnerEnvironment(c, e), [
    (e) => { e.githubActions = undefined; }, (e) => { e.runId = "54321"; }, (e) => { e.runAttempt = "1"; },
    (e) => { e.platform = "darwin"; }, (e) => { e.arch = "arm64"; }, (e) => { e.nodeMajor = 25; },
    (e) => { e.dockerReachable = false; }, (e) => { e.freeBytes = c.freeFloorBytes - 1; },
  ]);
});

test("fixed-name collisions are rejected even for previously owned resources", () => {
  rejectsMutations({ containers: [], volumes: [], loopbackListeners: [] }, assertAdmissionResourcesAbsent, [
    (e) => { e.containers = ["b1-admission-pg-20261006"]; },
    (e) => { e.volumes = ["b1-admission-mongo-20261006-data"]; },
    (e) => { e.loopbackListeners = [55439]; },
  ]);
});

test("checkout rejects drift, branch emulation, omitted package build or unacknowledged migration", () => {
  const c = contract();
  const evidence = {
    lk1Head: c.source.lk1Head, lk2Head: c.source.lk2Head, helperBlob: c.source.helperBlob,
    lk1AdmissionAncestor: true, lk1MoneyAncestor: true, lk1OwnerCiAncestor: true, lk1TrackedClean: true, lk2TrackedClean: true,
    lk2Detached: true, helperPath: c.helperPath, lockInstall: "npm ci --include=optional --no-audit --no-fund",
    packageBuild: ["contracts:generate", "build:packages"], emptyDatabaseVerified: true,
    migrationAcknowledgement: c.migrationAcknowledgement, migrationExitCode: 0,
    installExitCode: 0, generationExitCode: 0, packageBuildExitCode: 0, migrationLedgerMatches: true,
  };
  const mutations = [
    ...["lk1AdmissionAncestor", "lk1MoneyAncestor", "lk1OwnerCiAncestor", "lk1TrackedClean", "lk2TrackedClean", "lk2Detached", "emptyDatabaseVerified"].map((key) => (e) => { e[key] = false; }),
    (e) => { e.lk2Head = "a".repeat(40); }, (e) => { e.helperBlob = "a".repeat(40); },
    (e) => { e.helperPath = "scripts/old-helper.ts"; }, (e) => { e.lockInstall = "npm install"; },
    (e) => { e.packageBuild = []; }, (e) => { e.migrationAcknowledgement = ""; }, (e) => { e.migrationExitCode = 1; },
    (e) => { e.installExitCode = 1; }, (e) => { e.generationExitCode = 1; },
    (e) => { e.packageBuildExitCode = 1; }, (e) => { e.migrationLedgerMatches = false; },
  ];
  rejectsMutations(evidence, (e) => assertAdmissionCheckout(c, e), mutations);
});

test("Mac config IDs and tag-only image presence cannot satisfy runner image proof", () => {
  const c = contract();
  for (const kind of ["mongo", "pg"]) {
    const f = c.fixtures[kind];
    rejectsMutations({ Os: "linux", Architecture: "amd64", Id: f.imageId, RepoDigests: [f.image] },
      (e) => assertAdmissionImage(c, kind, e), [
        (e) => { e.Architecture = "arm64"; }, (e) => { e.Os = "darwin"; },
        (e) => { e.Id = `sha256:${"e".repeat(64)}`; }, (e) => { e.RepoDigests = []; },
      ]);
  }
});

test("PostgreSQL index is bound to its amd64 child; Mongo ARM manifest is rejected", () => {
  const c = contract();
  const pg = {
    digest: c.fixtures.pg.image.split("@")[1], mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [{ digest: "sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551",
      mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os: "linux", architecture: "amd64" } }],
  };
  rejectsMutations(pg, (e) => assertAdmissionRegistryDescriptor(c, "pg", e), [
    (e) => { e.digest = c.fixtures.pg.imageId; }, (e) => { e.manifests[0].digest = `sha256:${"e".repeat(64)}`; },
    (e) => { e.manifests[0].platform.architecture = "arm64"; }, (e) => { e.manifests.push(e.manifests[0]); },
  ]);
  rejectsMutations({ digest: c.fixtures.mongo.image.split("@")[1], mediaType: "application/vnd.oci.image.manifest.v1+json" },
    (e) => assertAdmissionRegistryDescriptor(c, "mongo", e), [
      (e) => { e.digest = "sha256:06dac52f00d294982cab93756436a2f67806101b485a34dca758116311338fdd"; },
      (e) => { e.mediaType = "application/vnd.oci.image.index.v1+json"; },
    ]);
});

test("container custody rejects foreign resources, widened ports, bind mounts and uncapped processes", () => {
  const c = contract(); const f = c.fixtures.mongo;
  const valid = {
    container: {
      Id: "a".repeat(64), Name: `/${f.name}`, Image: f.imageId,
      Config: { Image: f.image, Labels: { ...f.labels } }, State: { Running: true, OOMKilled: false },
      HostConfig: { Privileged: false, NetworkMode: "bridge", AutoRemove: false, RestartPolicy: { Name: "no" },
        CapAdd: [], Memory: f.memory, NanoCpus: f.nanoCpus, PidsLimit: f.pidsLimit, Tmpfs: f.tmpfs,
        SecurityOpt: ["no-new-privileges"], PortBindings: { [f.containerPort]: [{ HostIp: "127.0.0.1", HostPort: f.hostPort }] } },
      Mounts: f.volumes.map((Name) => ({ Name, Type: "volume", RW: true })),
    },
    volumes: f.volumes.map((Name) => ({ Name, Driver: "local", Options: {}, Labels: { ...f.labels } })),
  };
  rejectsMutations(valid, (e) => assertAdmissionContainer(c, "mongo", e.container, e.volumes), [
    (e) => { e.container.Id = ""; }, (e) => { e.container.Name = "/foreign"; },
    (e) => { e.container.Config.Labels["padlhub.ci.owner"] = "foreign"; },
    (e) => { e.container.State.Running = false; }, (e) => { e.container.State.OOMKilled = true; },
    (e) => { e.container.HostConfig.Privileged = true; }, (e) => { e.container.HostConfig.NetworkMode = "host"; },
    (e) => { e.container.HostConfig.Memory = 0; }, (e) => { e.container.HostConfig.NanoCpus = 0; },
    (e) => { e.container.HostConfig.PidsLimit = 0; }, (e) => { e.container.HostConfig.Tmpfs = {}; },
    (e) => { e.container.HostConfig.SecurityOpt = []; }, (e) => { e.container.HostConfig.RestartPolicy.Name = "always"; },
    (e) => { e.container.HostConfig.PortBindings[f.containerPort][0].HostIp = "0.0.0.0"; },
    (e) => { e.container.Mounts[0].Type = "bind"; }, (e) => { e.volumes[0].Labels["padlhub.task"] = "foreign"; },
    (e) => { e.volumes[0].Options = { device: "/foreign" }; },
  ]);
});

test("cleanup refuses replaced IDs and foreign run labels, including on stopped containers", () => {
  const c = contract(); const f = c.fixtures.pg; const id = "a".repeat(64);
  const valid = {
    container: { Id: id, Name: `/${f.name}`, Image: f.imageId, Config: { Image: f.image, Labels: { ...f.labels } }, State: { Running: false } },
    volumes: f.volumes.map((Name) => ({ Name, Driver: "local", Options: {}, Labels: { ...f.labels } })),
  };
  rejectsMutations(valid, (e) => assertAdmissionCleanupIdentity(c, "pg", id, e.container, e.volumes), [
    (e) => { e.container.Id = "b".repeat(64); }, (e) => { e.container.Config.Labels["padlhub.ci-run"] = "54321"; },
    (e) => { delete e.volumes[0].Labels["padlhub.ci-attempt"]; }, (e) => { e.volumes[0].Labels["padlhub.ci.owner"] = "foreign"; },
  ]);
});

test("physical proof requires one real test, no skips and no provider/business write", () => {
  const proof = { proof: "LOCAL_PHYSICAL_AUTH_PG_MONGO_B1", ownerRecords: 4, providerWrites: 0, ownerUpdates: 0, sourcePath: true };
  const tap = `# ${JSON.stringify(proof)}\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  assert.deepEqual(assertAdmissionPhysicalProof(tap, 0), { physicalTests: 1, skipped: 0, providerWrites: 0 });
  for (const invalid of ["", tap.replace("# skipped 0", "# skipped 1"), tap.replace("# pass 1", "# pass 0"),
    tap.replace('"providerWrites":0', '"providerWrites":1'), tap.replace('"sourcePath":true', '"sourcePath":false'),
    tap.replace("# tests 1", "# tests 2"), `${tap}# ${JSON.stringify(proof)}\n`, `${tap}# tests 1\n`,
    `${tap}# postgresql://synthetic\n`, `${tap}# PRIVATE KEY\n`, `${tap}# password=synthetic\n`])
    assert.throws(() => assertAdmissionPhysicalProof(invalid, 0), assert.AssertionError);
  assert.throws(() => assertAdmissionPhysicalProof(tap, 1), assert.AssertionError);
});

test("cleanup receipt cannot omit resources, listeners, disk failure or owner identity", () => {
  const c = contract();
  rejectsMutations({ owner: c.owner, containers: [], volumes: [], loopbackListeners: [], taskNetworks: [], childProcesses: [],
    temporaryArtifactsRemoved: true, fixtureDiskBudgetExceeded: false, freeBeforeBytes: c.freeFloorBytes, minSampledFreeBytes: c.freeFloorBytes,
    freeAfterBytes: c.freeFloorBytes, fixtureBytes: c.fixtureDiskBudgetBytes },
    (e) => assertAdmissionCleanup(c, e), [
      (e) => { e.owner = "foreign"; }, (e) => { e.containers = [c.fixtures.pg.name]; },
      (e) => { e.volumes = [c.fixtures.mongo.volumes[0]]; }, (e) => { e.loopbackListeners = [55439]; },
      (e) => { e.fixtureDiskBudgetExceeded = true; },
      (e) => { e.taskNetworks = ["retained"]; }, (e) => { e.childProcesses = [123]; },
      (e) => { e.fixtureBytes += 1; }, (e) => { delete e.freeBeforeBytes; },
      (e) => { e.temporaryArtifactsRemoved = false; },
      (e) => { e.minSampledFreeBytes -= 1; }, (e) => { e.freeAfterBytes -= 1; },
    ]);
});

test("signal custody rejects PID reuse, foreign parents/groups and missing live identity", () => {
  const fields = ["S", "41", "42", "42", ...Array(15).fill("0"), "991"];
  const original = linuxProcessIdentity(`42 (child name) ${fields.join(" ")}`);
  assert.equal(sameOwnedProcess(original, original, 42, 41), true);
  for (const current of [null, { ...original, started: "992" }, { ...original, parent: 43 },
    { ...original, group: 43 }, { ...original, session: 43 }, { ...original, pid: 43 }])
    assert.equal(sameOwnedProcess(original, current, 42, 41), false);
});

test("actual runner denies a non-GHA host before any fixture, checkout or dependency action", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../runB1BookedOperationAdmissionCi.mjs", import.meta.url))], {
    env: { PATH: process.env.PATH, GITHUB_ACTIONS: "false" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr, /^B1_ADMISSION_CI_PREFLIGHT_FAILURE ERR_ASSERTION\n$/);
});

test("partial fixture cleanup preserves foreign resources and continues after an owned removal failure", async () => {
  const c = contract(); const removed = []; const present = new Map();
  for (const f of Object.values(c.fixtures)) for (const name of f.volumes)
    present.set(name, { Name: name, Driver: "local", Options: {}, Labels: { ...f.labels } });
  const mongo = c.fixtures.mongo; const pg = c.fixtures.pg;
  present.delete(mongo.volumes[1]); // second create failed, first owned volume exists
  const createdVolumes = new Set([...mongo.volumes, ...pg.volumes]);
  const fixture = {
    contract: c, created: {}, createdVolumes, cleanupDeadline: Date.now() + 5000,
    portFree: async () => {},
    inspect: async (_label, _kind, name) => { if (!present.has(name)) throw Error("missing"); return present.get(name); },
    docker: async (_label, args) => {
      if (args[0] === "container") return "";
      if (args[1] === "ls") return [...present.keys()].filter(name => !args.includes("--filter") || args.includes(`name=^${name}$`)).join("\n");
      assert.deepEqual(args.slice(0, 2), ["volume", "rm"]);
      if (args[2] === mongo.volumes[0]) throw Error("synthetic removal failure");
      removed.push(args[2]); present.delete(args[2]); return args[2];
    },
  };
  const failures = await cleanupAdmissionFixtures(fixture);
  assert.ok(failures.some(error => error.stage === `volume:${mongo.volumes[0]}`));
  assert.deepEqual(removed, pg.volumes); // later resource cleaned despite Mongo failure
  present.set(pg.volumes[0], { Name: pg.volumes[0], Driver: "local", Labels: { ...pg.labels, "padlhub.ci.owner": "foreign" } });
  removed.length = 0;
  const foreign = await cleanupAdmissionFixtures(fixture);
  assert.ok(foreign.some(error => error.stage === `volume:${pg.volumes[0]}`));
  assert.deepEqual(removed, []);
});

test("container cleanup uses fresh exact identities and handles later containers after inspect failure", async () => {
  const c = contract(); const removed = []; const ids = { mongo: "a".repeat(64), pg: "b".repeat(64) };
  const result = await cleanupAdmissionFixtures({ contract: c, created: ids, createdVolumes: new Set(),
    cleanupDeadline: Date.now() + 5000, portFree: async () => {},
    inspect: async (_label, kind, value) => {
      if (kind === "volume") { const f = value.includes("-mongo-") ? c.fixtures.mongo : c.fixtures.pg;
        return { Name: value, Driver: "local", Labels: f.labels }; }
      if (value === ids.mongo) throw Error("synthetic inspect failure");
      const f = c.fixtures.pg;
      return { Id: ids.pg, Name: `/${f.name}`, Image: f.imageId, Config: { Image: f.image, Labels: f.labels } };
    },
    docker: async (_label, args) => { if (["stop", "rm"].includes(args[0])) removed.push(args); return ""; },
  });
  assert.ok(result.some(error => error.stage === "container:mongo"));
  assert.deepEqual(removed, [["stop", "--time=10", ids.pg], ["rm", ids.pg]]);
});

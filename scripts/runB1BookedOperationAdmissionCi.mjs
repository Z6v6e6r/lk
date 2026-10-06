import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  admissionCiImages, admissionTask, createAdmissionCiContract, assertAdmissionCheckout,
  assertAdmissionRunnerEnvironment, assertAdmissionResourcesAbsent, assertAdmissionRegistryDescriptor,
  assertAdmissionImage, assertAdmissionContainer, assertAdmissionCleanupIdentity,
  assertAdmissionPhysicalProof, assertAdmissionCleanup,
} from "./b1BookedOperationAdmissionCiContract.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freeBytes = async (path) => { const fs = await statfs(path); return fs.bavail * fs.bsize; };
export function linuxProcessIdentity(stat) {
  const end = stat.lastIndexOf(") ");
  assert.ok(end > 0);
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  return { pid: Number(stat.slice(0, stat.indexOf(" "))), parent: Number(fields[1]),
    group: Number(fields[2]), session: Number(fields[3]), started: fields[19] };
}

export function sameOwnedProcess(original, current, pid, parent) {
  return Boolean(original && current && original.pid === pid && current.pid === pid &&
    original.parent === parent && current.parent === parent &&
    original.group === pid && current.group === pid && original.session === pid && current.session === pid &&
    /^[0-9]+$/.test(original.started) && original.started === current.started);
}

const processIdentity = (pid) => {
  try { return linuxProcessIdentity(readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch { return null; }
};

export async function runAdmissionCi() {
  // This guard precedes every directory, network, dependency or Docker action.
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, "Z6v6e6r/lk");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
  assert.equal(Number(process.versions.node.split(".")[0]), 22);
  assert.equal(realpathSync(process.cwd()), realpathSync(root));
  const pins = {
    lk1Head: process.env.B1_ADMISSION_LK1_HEAD,
    lk1AdmissionHead: process.env.B1_ADMISSION_LK1_SOURCE_HEAD,
    lk1MoneyHead: "507a82a902a00d8bd0d66edf65a601cfdc23b969",
    lk1OwnerCiHead: "787602d2b0c61056482f6946a8c8a26d8b5f0813",
    lk2Head: process.env.B1_ADMISSION_LK2_HEAD,
    helperBlob: process.env.B1_ADMISSION_LK2_HELPER_BLOB,
  };
  for (const value of Object.values(pins)) assert.match(value ?? "", /^(?!0{40}$)[a-f0-9]{40}$/);
  const runId = process.env.GITHUB_RUN_ID; const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  assert.match(runId ?? "", /^[1-9][0-9]+$/); assert.match(runAttempt ?? "", /^[1-9][0-9]*$/);
  assert.ok(process.env.RUNNER_TEMP);
  const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
  let dockerStorage;
  const availableBytes = async () => Math.min(await freeBytes(root), await freeBytes(runnerTemp), dockerStorage ? await freeBytes(dockerStorage) : Infinity);
  const freeBeforeBytes = await availableBytes(); assert.ok(freeBeforeBytes >= 5 * 1024 ** 3);
  const temp = await mkdtemp(join(runnerTemp, "b1-admission-ci-"));
  await mkdir(join(temp, "docker"), { mode: 0o700 });
  await mkdir(join(temp, "home"), { mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: join(temp, "home"), CI: "1", NO_COLOR: "1", TMPDIR: temp,
    DOCKER_CONFIG: join(temp, "docker"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", npm_config_cache: join(temp, "npm-cache"), npm_config_userconfig: "/dev/null",
    NODE_OPTIONS: "--max-old-space-size=768",
  };
  let stage = "preflight"; let sequence = 0; let contract; let physicalGroup; let cleanupDeadline;
  let minSampledFreeBytes = freeBeforeBytes; let fixtureBytes = 0; let aborted = false; let cleaning = false;
  const children = new Set(); const identities = new Map(); const escalations = new Map();
  const created = {}; const createdVolumes = new Set();
  const signalOwned = (child, signal) => {
    if (!children.has(child) || child.exitCode !== null || child.signalCode !== null ||
      !sameOwnedProcess(identities.get(child), processIdentity(child.pid), child.pid, process.pid)) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const stopOwned = (child) => {
    signalOwned(child, "SIGTERM");
    if (!escalations.has(child)) escalations.set(child, setTimeout(() => signalOwned(child, "SIGKILL"), 5000));
  };
  const interrupt = () => { aborted = true; if (!cleaning) for (const child of children) stopOwned(child); };
  const deadline = setTimeout(interrupt, 24 * 60_000);
  process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
  async function run(label, command, args, options = {}) {
    if (aborted && !options.cleanup) throw new Error("B1_CI_ABORTED");
    if (options.cleanup) assert.ok(Date.now() < cleanupDeadline, "cleanup deadline");
    stage = label;
    minSampledFreeBytes = Math.min(minSampledFreeBytes, await availableBytes());
    if (!options.cleanup) assert.ok(minSampledFreeBytes >= 5 * 1024 ** 3);
    const log = openSync(join(temp, `${++sequence}-${label}.log`), "wx", 0o600);
    let output = ""; let timedOut = false;
    try {
      const child = spawn(command, args, { cwd: options.cwd ?? root, env: { ...env, ...options.env }, detached: true, stdio: ["ignore", "pipe", log] });
      children.add(child); if (label === "physical") physicalGroup = child.pid;
      child.once("spawn", () => identities.set(child, processIdentity(child.pid)));
      child.stdout.on("data", (chunk) => { if (!options.sensitive) writeSync(log, chunk); if (options.capture) { output += chunk.toString(); if (output.length > 1_000_000) signalOwned(child, "SIGKILL"); } });
      const timer = setTimeout(() => {
        timedOut = true; stopOwned(child);
      }, options.cleanup ? Math.min(options.timeout ?? 60_000, Math.max(1, cleanupDeadline - Date.now())) : options.timeout ?? 60_000);
      const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); })
        .finally(() => { clearTimeout(timer); clearTimeout(escalations.get(child)); escalations.delete(child); identities.delete(child); children.delete(child); });
      assert.equal(timedOut, false, `${label}: bounded command timeout`);
      assert.equal(result.code, 0, `${label}: nonzero command exit`);
      assert.equal(result.signal, null, `${label}: interrupted command`);
      assert.ok(output.length <= 1_000_000);
      return output.trim();
    } finally { closeSync(log); }
  }
  const docker = (label, args, options = {}) => run(label, "docker", args, { capture: true, ...options });
  const inspect = async (label, kind, name, cleanup = false) => JSON.parse(await docker(label, [kind, "inspect", name], { cleanup, sensitive: kind === "container" }))[0];
  const portFree = async (port) => {
    const { createServer } = await import("node:net"); const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  let proof; let failure; let cleanupProof; const cleanupFailures = [];
  const cleanAttempt = async (label, action) => {
    try { await action(); } catch (error) { cleanupFailures.push({ stage: label, code: error.code ?? error.name }); }
  };
  try {
    assert.equal(await docker("docker_version", ["version", "--format", "{{.Server.Os}}"]), "linux");
    dockerStorage = await docker("docker_root", ["info", "--format", "{{.DockerRootDir}}"]);
    assert.ok(dockerStorage.startsWith("/"));
    assert.ok(await availableBytes() >= 5 * 1024 ** 3);
    assert.equal(await run("lk1_head", "git", ["rev-parse", "HEAD"], { capture: true }), pins.lk1Head);
    for (const pin of [pins.lk1AdmissionHead, pins.lk1MoneyHead, pins.lk1OwnerCiHead]) await run("lk1_ancestor", "git", ["merge-base", "--is-ancestor", pin, pins.lk1Head]);
    assert.equal(await run("lk1_clean", "git", ["status", "--porcelain", "--untracked-files=no"], { capture: true }), "");
    await readFile(join(root, "scripts/tests/bookedOperationAdmission.mongo.test.mjs"));
    const checkout = join(temp, "lk2"); await mkdir(checkout, { mode: 0o700 });
    await run("lk2_init", "git", ["init", "--quiet", checkout]);
    await run("lk2_remote", "git", ["-C", checkout, "remote", "add", "origin", "https://github.com/Z6v6e6r/lk2.git"]);
    await run("lk2_fetch", "git", ["-C", checkout, "fetch", "--depth=1", "origin", pins.lk2Head], { timeout: 120_000 });
    await run("lk2_detach", "git", ["-C", checkout, "checkout", "--detach", pins.lk2Head]);
    assert.equal(await run("lk2_head", "git", ["-C", checkout, "rev-parse", "HEAD"], { capture: true }), pins.lk2Head);
    assert.equal(await run("lk2_detached", "git", ["-C", checkout, "branch", "--show-current"], { capture: true }), "");
    assert.equal(await run("helper_blob", "git", ["-C", checkout, "rev-parse", "HEAD:scripts/b1-booked-operation-admission-rehearsal.ts"], { capture: true }), pins.helperBlob);
    assert.equal(await run("lk2_clean", "git", ["-C", checkout, "status", "--porcelain", "--untracked-files=no"], { capture: true }), "");
    await run("install", "npm", ["ci", "--include=optional", "--no-audit", "--no-fund"], { cwd: checkout, timeout: 420_000 });
    for (const script of ["contracts:generate", "build:packages"]) await run(script.replace(":", "_"), "npm", ["run", script], { cwd: checkout, timeout: 600_000 });
    assert.equal(await run("lk2_build_clean", "git", ["-C", checkout, "status", "--porcelain", "--untracked-files=no"], { capture: true }), "");
    const images = {}; const descriptors = {};
    for (const [kind, reference] of Object.entries(admissionCiImages)) {
      descriptors[kind] = JSON.parse(await docker(`descriptor_${kind}`, ["buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"]));
      await docker(`pull_${kind}`, ["pull", "--platform=linux/amd64", reference], { capture: false, timeout: 180_000 });
      const image = await inspect(`image_${kind}`, "image", reference);
      images[kind] = { reference, imageId: image.Id };
    }
    contract = createAdmissionCiContract({ ...pins, runId, runAttempt, ownerNonce: randomBytes(16).toString("hex"), platform: "linux/amd64", nodeMajor: 22, images });
    assertAdmissionRunnerEnvironment(contract, { githubActions: process.env.GITHUB_ACTIONS, runId, runAttempt, platform: process.platform, arch: process.arch, nodeMajor: 22, dockerReachable: true, freeBytes: await freeBytes(root) });
    for (const kind of ["mongo", "pg"]) {
      const f = contract.fixtures[kind]; assertAdmissionRegistryDescriptor(contract, kind, descriptors[kind]);
      assertAdmissionImage(contract, kind, await inspect(`image_check_${kind}`, "image", f.image));
      const containers = await docker(`collision_${kind}`, ["container", "ls", "-a", "--filter", `name=^/${f.name}$`, "--format", "{{.ID}}"]);
      const volumes = (await docker(`volume_collision_${kind}`, ["volume", "ls", "--format", "{{.Name}}"])).split("\n").filter((name) => f.volumes.includes(name));
      await portFree(Number(f.hostPort)); assertAdmissionResourcesAbsent({ containers: containers ? [containers] : [], volumes, loopbackListeners: [] });
    }
    const passwords = { mongo: randomBytes(32).toString("hex"), pg: randomBytes(32).toString("hex") };
    for (const kind of ["mongo", "pg"]) {
      const f = contract.fixtures[kind]; const labels = Object.entries(f.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
      for (const name of f.volumes) {
        createdVolumes.add(name);
        await docker(`volume_${kind}`, ["volume", "create", ...labels, name]);
        const volume = await inspect(`volume_identity_${kind}`, "volume", name);
        for (const [key, value] of Object.entries(f.labels)) assert.equal(volume.Labels?.[key], value);
        assert.equal(volume.Driver, "local"); assert.deepEqual(volume.Options ?? {}, {});
      }
      const environmentFile = join(temp, `${kind}.env`);
      await writeFile(environmentFile, kind === "mongo" ? `MONGO_INITDB_ROOT_USERNAME=b1_fixture\nMONGO_INITDB_ROOT_PASSWORD=${passwords.mongo}\n` : `POSTGRES_USER=b1_fixture\nPOSTGRES_PASSWORD=${passwords.pg}\nPOSTGRES_DB=b1_admission\n`, { flag: "wx", mode: 0o600 });
      const destinations = kind === "mongo" ? ["/data/db", "/data/configdb"] : ["/var/lib/postgresql/data"];
      created[kind] = await docker(`create_${kind}`, ["create", "--name", f.name, ...labels, "--memory=512m", "--cpus=1", "--pids-limit=128", "--restart=no", "--network=bridge", "--security-opt=no-new-privileges", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864", "--publish", `127.0.0.1:${f.hostPort}:${f.containerPort.split("/")[0]}`, "--env-file", environmentFile, ...f.volumes.flatMap((name, i) => ["--volume", `${name}:${destinations[i]}`]), f.image]);
      assert.match(created[kind], /^[a-f0-9]{64}$/); await docker(`start_${kind}`, ["start", created[kind]]);
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          await docker(`ready_${kind}`, kind === "pg" ? ["exec", created[kind], "pg_isready", "-U", "b1_fixture", "-d", "b1_admission"] : ["exec", created[kind], "mongosh", "--quiet", "--eval", 'const a=db.getSiblingDB("admin"); a.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD); if(a.runCommand({ping:1}).ok!==1) quit(1);'], { timeout: 3000 });
          ready = true; break;
        } catch { if (aborted) throw new Error("B1_CI_ABORTED"); await pause(1000); }
      }
      assert.equal(ready, true, `${kind}: readiness timeout`);
      assertAdmissionContainer(contract, kind, await inspect(`container_${kind}`, "container", created[kind]), await Promise.all(f.volumes.map((name) => inspect(`volume_ready_${kind}`, "volume", name))));
    }
    const pgUrl = `postgresql://b1_fixture:${passwords.pg}@127.0.0.1:55439/b1_admission`;
    const empty = await docker("empty_database", ["exec", created.pg, "psql", "-U", "b1_fixture", "-d", "b1_admission", "-Atc", "select count(*) from pg_catalog.pg_tables where schemaname='public'"]);
    assert.equal(empty, "0");
    await run("migrate", process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { cwd: checkout, env: { DATABASE_URL: pgUrl, CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK: contract.migrationAcknowledgement }, timeout: 180_000 });
    const files = (await readdir(join(checkout, "packages/database/migrations"))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    const packaged = await Promise.all(files.map(async (filename) => ({ filename, checksum: createHash("sha256").update(await readFile(join(checkout, "packages/database/migrations", filename))).digest("hex") })));
    const ledger = JSON.parse(await docker("migration_ledger", ["exec", created.pg, "psql", "-U", "b1_fixture", "-d", "b1_admission", "-Atc", "select coalesce(json_agg(t order by filename),'[]'::json) from (select filename, checksum from public.schema_migrations) t"]));
    assert.deepEqual(ledger, packaged);
    assertAdmissionCheckout(contract, { ...pins, lk1AdmissionAncestor: true, lk1MoneyAncestor: true, lk1OwnerCiAncestor: true, lk1TrackedClean: true, lk2TrackedClean: true, lk2Detached: true, helperPath: contract.helperPath, lockInstall: "npm ci --include=optional --no-audit --no-fund", packageBuild: ["contracts:generate", "build:packages"], installExitCode: 0, generationExitCode: 0, packageBuildExitCode: 0, emptyDatabaseVerified: true, migrationAcknowledgement: contract.migrationAcknowledgement, migrationExitCode: 0, migrationLedgerMatches: true });
    const tap = await run("physical", process.execPath, ["--test", "--test-reporter=tap", contract.testPath], { capture: true, timeout: 90_000, env: { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt, B1_ADMISSION_REQUIRED: "1", B1_ADMISSION_ACK: admissionTask, B1_ADMISSION_MONGO_URL: `mongodb://b1_fixture:${passwords.mongo}@127.0.0.1:27039/?authSource=admin`, B1_ADMISSION_PG_URL: pgUrl, B1_ADMISSION_LK1_HEAD: pins.lk1Head, B1_ADMISSION_LK2_HEAD: pins.lk2Head, B1_ADMISSION_LK2_CHECKOUT: checkout } });
    proof = assertAdmissionPhysicalProof(tap, 0);
    for (const kind of ["mongo", "pg"]) {
      const paths = kind === "mongo" ? ["/data/db", "/data/configdb"] : ["/var/lib/postgresql/data"];
      const sizes = await docker(`data_size_${kind}`, ["exec", created[kind], "du", "-sk", ...paths]);
      for (const line of sizes.split("\n")) { const match = line.match(/^([0-9]+)\s/); assert.ok(match); fixtureBytes += Number(match[1]) * 1024; }
    }
    assert.ok(fixtureBytes <= contract.fixtureDiskBudgetBytes);
  } catch (error) { failure = { stage, code: error.code ?? error.name }; }
  finally {
    clearTimeout(deadline); cleaning = true;
    cleanupDeadline = Date.now() + 180_000;
    try {
      if (contract) {
        for (const kind of ["mongo", "pg"]) {
          const f = contract.fixtures[kind];
          if (created[kind]) await cleanAttempt(`container:${kind}`, async () => {
            const volumes = await Promise.all(f.volumes.map((name) => inspect(`cleanup_volume_${kind}`, "volume", name, true)));
            assertAdmissionCleanupIdentity(contract, kind, created[kind], await inspect(`cleanup_container_${kind}`, "container", created[kind], true), volumes);
            await docker(`stop_${kind}`, ["stop", "--time=10", created[kind]], { cleanup: true });
            await docker(`remove_${kind}`, ["rm", created[kind]], { cleanup: true });
          });
          for (const name of f.volumes.filter((value) => createdVolumes.has(value))) {
            await cleanAttempt(`volume:${name}`, async () => {
            assert.ok(Date.now() < cleanupDeadline, "cleanup deadline");
            const present = await docker(`volume_present_${kind}`, ["volume", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"], { cleanup: true });
            if (present === "") return;
            assert.equal(present, name);
            const volume = await inspect(`delete_volume_${kind}`, "volume", name, true);
            for (const [key, value] of Object.entries(f.labels)) assert.equal(volume.Labels?.[key], value);
            assert.equal(volume.Name, name); assert.equal(volume.Driver, "local"); assert.deepEqual(volume.Options ?? {}, {});
            await docker(`remove_volume_${kind}`, ["volume", "rm", name], { cleanup: true });
            });
          }
          await cleanAttempt(`fixed_identity:${kind}`, async () => {
            await portFree(Number(f.hostPort));
            const fixedContainer = await docker(`fixed_container_${kind}`, ["container", "ls", "-a", "--filter", `name=^/${f.name}$`, "--format", "{{.ID}}"], { cleanup: true });
            assert.equal(fixedContainer, "");
            const fixedVolumes = (await docker(`fixed_volumes_${kind}`, ["volume", "ls", "--format", "{{.Name}}"], { cleanup: true })).split("\n").filter((name) => f.volumes.includes(name));
            assert.deepEqual(fixedVolumes, []);
          });
        }
        const filter = ["--filter", `label=padlhub.ci.owner=${contract.owner}`];
        const containers = await docker("container_residue", ["container", "ls", "-a", ...filter, "--format", "{{.ID}}"], { cleanup: true });
        const volumes = await docker("volume_residue", ["volume", "ls", ...filter, "--format", "{{.Name}}"], { cleanup: true });
        const networks = await docker("network_residue", ["network", "ls", ...filter, "--format", "{{.ID}}"], { cleanup: true });
        const processes = await run("process_residue", "ps", ["-eo", "pid,pgid"], { capture: true, cleanup: true });
        const remaining = processes.split("\n").filter((line) => physicalGroup && Number(line.trim().split(/\s+/)[1]) === physicalGroup);
        cleanupProof = { owner: contract.owner, containers: containers ? [containers] : [], volumes: volumes ? [volumes] : [], loopbackListeners: [], taskNetworks: networks ? [networks] : [], childProcesses: remaining, freeBeforeBytes, minSampledFreeBytes, freeAfterBytes: await availableBytes(), fixtureBytes, fixtureDiskBudgetExceeded: fixtureBytes > contract.fixtureDiskBudgetBytes, temporaryArtifactsRemoved: false };
        assert.equal(children.size, 0);
      }
    } catch (error) { cleanupFailures.push({ stage: `cleanup:${stage}`, code: error.code ?? error.name }); }
  }
  await cleanAttempt("temporary_artifacts", async () => { await rm(temp, { recursive: true, force: true }); });
  if (cleanupProof) {
    cleanupProof.temporaryArtifactsRemoved = !cleanupFailures.some((error) => error.stage === "temporary_artifacts");
    cleanupProof.freeAfterBytes = await availableBytes();
    await cleanAttempt("cleanup_receipt", async () => assertAdmissionCleanup(contract, cleanupProof));
  }
  if (aborted && !failure) failure = { stage: "interrupted", code: "B1_CI_ABORTED" };
  const receipt = { status: failure || cleanupFailures.length ? "FAILURE" : "SUCCESS", runId, runAttempt, source: pins, owner: contract?.owner, images: contract?.fixtures && Object.fromEntries(Object.entries(contract.fixtures).map(([kind, f]) => [kind, { reference: f.image, runtimeId: f.imageId }])), proof, cleanup: cleanupProof, failure, cleanupFailures };
  await writeFile(`${temp}-receipt.json`, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt);
  if (receipt.status === "FAILURE") { process.stderr.write(`B1_ADMISSION_CI_FAILURE ${JSON.stringify({ failure, cleanupFailures })}\n`); return 1; }
  assert.ok(proof && cleanupProof); process.stdout.write(`B1_ADMISSION_CI_SUCCESS ${JSON.stringify(receipt)}\n`); return 0;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  runAdmissionCi().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`B1_ADMISSION_CI_PREFLIGHT_FAILURE ${error.code ?? error.name}\n`); process.exitCode = 1;
  });
}

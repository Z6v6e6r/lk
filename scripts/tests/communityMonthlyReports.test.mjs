import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { MongoClient, BSON } from "mongodb";
import { publishCommunityMonthlyReports, monthlyReportMongoUri } from "../community_monthly_reports.mjs";
import { COMMUNITY_MONTHLY_COLLECTION } from "../../src/services/community-rating/monthlyContract.ts";

const nowTs = Date.parse("2026-10-19T10:00:00Z");
const fixture = () => ({ id: "c", name: "Community", visibility: "OPEN", members: Array.from({ length: 12 }, (_, i) => ({ id: "p" + i, name: "Участник " + i, avatar: "https://media.example.test/p.webp" })) });
function fakeDb({ before = null, race = false, badReadback = false, duplicateInsert = false, unacknowledged = false } = {}) {
  let saved = before, writes = 0, reads = 0;
  const target = {
    async findOne() { reads++; return badReadback && reads > 1 ? { ...saved, totalMembers: -1 } : saved; },
    async insertOne(doc) { if (duplicateInsert) throw Object.assign(new Error("duplicate"), { code: 11000 }); saved = structuredClone(doc); writes++; return { acknowledged: !unacknowledged, insertedId: doc._id }; },
    async replaceOne(filter, doc, options) {
      assert.equal(options.upsert, false);
      assert.equal(filter.$expr.$eq[0], "$$ROOT");
      if (race || !isDeepStrictEqual(filter.$expr.$eq[1].$literal, saved)) return { acknowledged: true, matchedCount: 0 };
      saved = structuredClone(doc); writes++; return { acknowledged: !unacknowledged, matchedCount: 1 };
    },
  };
  const forbidden = () => { throw new Error("SOURCE_WRITE_FORBIDDEN"); };
  return {
    collection(name) {
      if (name === COMMUNITY_MONTHLY_COLLECTION) return target;
      return { find: () => ({ toArray: async () => name === "lk_communities" ? [fixture()] : [] }), updateOne: forbidden, replaceOne: forbidden, insertOne: forbidden, bulkWrite: forbidden, deleteMany: forbidden };
    },
    state: () => ({ saved, writes }),
  };
}
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monthly-report-only-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "preimages");
}
test("report-only dry-run preserves sources and writes nothing", async () => {
  const db = fakeDb();
  const result = await publishCommunityMonthlyReports({ db, nowTs });
  assert.equal(result.ok, true); assert.equal(result.published, 0); assert.equal(db.state().writes, 0);
  assert.equal(result.reports[0].rows, 12); assert.equal(result.tournamentWrites, 0); assert.equal(result.canonicalRatingWrites, 0);
});
test("report-only insertion preserves a protected preimage before its cache write", async t => {
  const backupDir = temp(t), db = fakeDb();
  const result = await publishCommunityMonthlyReports({ db, nowTs, apply: true, backupDir });
  assert.equal(result.ok, true); assert.equal(result.published, 1); assert.equal(db.state().writes, 1);
  const [file] = fs.readdirSync(backupDir);
  const preimage = BSON.EJSON.parse(fs.readFileSync(path.join(backupDir, file), "utf8"));
  assert.equal(preimage.before, null); assert.equal(preimage.id, db.state().saved._id);
  assert.deepEqual(preimage.after, db.state().saved);
  assert.equal(fs.statSync(path.join(backupDir, file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700);
  assert.equal(db.state().saved.items[0].avatarUrl, "https://media.example.test/p.webp");
  assert.match(result.reports[0].postimageSha256, /^[a-f0-9]{64}$/);
});
test("unacknowledged writes are failures even if the driver accepted the call", async t => {
  const result = await publishCommunityMonthlyReports({ db: fakeDb({ unacknowledged: true }), nowTs, apply: true, backupDir: temp(t) });
  assert.equal(result.ok, false); assert.equal(result.published, 0); assert.equal(result.writesAcknowledged, 0);
  assert.equal(result.failures[0].error, "REPORT_WRITE_UNACKNOWLEDGED");
});
test("Mongo target follows the active rating route, never the first URI in the flow", () => {
  const flow = [{ id: "tab", type: "tab" }, { id: "wrong", type: "mongodb4-client", uri: "mongodb://other.example.test/games" }, { id: "right", type: "mongodb4-client", uri: "mongodb://canonical.example.test/games" }, { id: "route", type: "http in", z: "tab", method: "get", url: "/lk/communities/:communityId/rating" }, { id: "read", type: "mongodb4", z: "tab", collection: "lk_communities", clientNode: "right" }];
  assert.equal(monthlyReportMongoUri(flow), "mongodb://canonical.example.test/games");
  assert.throws(() => monthlyReportMongoUri([...flow, { id: "other", type: "mongodb4", z: "tab", collection: "community_rating_snapshots", clientNode: "wrong" }]), /COMMUNITY_MONGO_CLIENT_REQUIRED/);
});
test("report-only CAS and insert conflicts fail without retry or source writes", async t => {
  const before = { _id: "community-monthly-v1:c:2026-10", updatedAt: "previous", sentinel: new BSON.Int32(7) };
  for (const config of [{ before, race: true }, { duplicateInsert: true }]) {
    const db = fakeDb(config), backupDir = temp(t);
    const result = await publishCommunityMonthlyReports({ db, nowTs, apply: true, backupDir });
    assert.equal(result.ok, false); assert.equal(result.published, 0); assert.equal(db.state().writes, 0);
    assert.match(result.failures[0].error, /REPORT_(SOURCE_CHANGED|INSERT_CONFLICT)/);
  }
});
test("whole-document readback catches corruption outside items", async t => {
  const result = await publishCommunityMonthlyReports({ db: fakeDb({ badReadback: true }), nowTs, apply: true, backupDir: temp(t) });
  assert.equal(result.ok, false); assert.equal(result.failures[0].error, "REPORT_POSTCHECK_FAILED");
  assert.equal(result.writesAcknowledged, 1); assert.equal(result.published, 0);
});

test("real reports-only wrapper keeps its lock throughout the timed child", { skip: process.platform !== "linux" }, t => {
  const root = path.dirname(temp(t));
  const wrapper = path.join(root, "deploy/rating-worker/run-monthly-reports.sh");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.copyFileSync("deploy/rating-worker/run-monthly-reports.sh", wrapper);
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "node"), '#!/usr/bin/env bash\nset -eu\ntest "$RATING_WORKER_SHARED_LOCK_HELD" = 1\nif flock -n "$RATING_WORKER_LOCK_FILE" -c true; then exit 88; fi\nreadlink /proc/self/fd/9 > "$LOCK_RECEIPT"\n', { mode: 0o755 });
  const lock = path.join(root, "shared.lock"), receipt = path.join(root, "lock-receipt");
  const result = spawnSync("bash", [wrapper], { encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: bin + ":" + process.env.PATH, RATING_WORKER_LOCK_FILE: lock, LOCK_RECEIPT: receipt } });
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.readFileSync(receipt, "utf8").trim(), lock);
  assert.equal(spawnSync("flock", ["-n", lock, "-c", "true"]).status, 0);
});
test("report-only wrapper holds the shared lock for the bounded child; timer has its own path", () => {
  const wrapper = fs.readFileSync("deploy/rating-worker/run-monthly-reports.sh", "utf8");
  assert.match(wrapper, /flock -w 840 -E 75 9/); assert.match(wrapper, /\} 9>"\$lock_file"/);
  assert.match(wrapper, /timeout --signal=TERM --kill-after=30s 780s/);
  assert.match(wrapper, /community_monthly_reports\.mjs" --apply/);
  assert.doesNotMatch(wrapper, /community_monthly_worker|run_rating_worker_147|configure-runtime-env/);
  const service = fs.readFileSync("deploy/rating-worker/community-monthly-reports.service", "utf8");
  assert.match(service, /\/opt\/padlhub-community-monthly\/current\//);
  assert.match(service, /Restart=on-failure/); assert.match(service, /StartLimitBurst=3/);
  const timer = fs.readFileSync("deploy/rating-worker/community-monthly-reports.timer", "utf8");
  assert.match(timer, /05:00:00 Europe\/Moscow/); assert.match(timer, /14:00:00 Europe\/Moscow/);
});

const uri = process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
test("real Mongo report-only cache insert and BSON-preserving CAS do not mutate tournaments or ratings", { skip: !uri }, async t => {
  const client = new MongoClient(uri); await client.connect();
  const db = client.db("community_monthly_reports_test_" + Date.now());
  const backupDir = temp(t);
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  await db.collection("lk_communities").insertOne(fixture());
  const tournament = { tournamentId: "unfinished", params: { finished: false }, rounds: [{ matches: [{ score1: 6, score2: 0 }] }] };
  await db.collection("tournaments").insertOne(tournament);
  const before = await db.collection("tournaments").findOne({ tournamentId: "unfinished" });
  const first = await publishCommunityMonthlyReports({ db, nowTs, apply: true, backupDir });
  assert.equal(first.ok, true); assert.equal(first.published, 1);
  const doc = await db.collection(COMMUNITY_MONTHLY_COLLECTION).findOne({});
  assert.equal(doc.items.length, 12); assert.equal(doc.items[0].rank, 1);
  await db.collection(COMMUNITY_MONTHLY_COLLECTION).updateOne({ _id: doc._id }, { $set: { sentinel: BSON.Long.fromString("9007199254740993") } });
  const second = await publishCommunityMonthlyReports({ db, nowTs: nowTs + 1000, apply: true, backupDir: temp(t) });
  assert.equal(second.ok, true); assert.equal(second.published, 1);
  assert.deepEqual(await db.collection("tournaments").findOne({ tournamentId: "unfinished" }), before);
  for (const name of ["rating_events", "player_rating_state", "community_rating_snapshots"]) assert.equal(await db.collection(name).countDocuments({}), 0);
  assert.equal(await db.collection(COMMUNITY_MONTHLY_COLLECTION).countDocuments({}), 1);
});

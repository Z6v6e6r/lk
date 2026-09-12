import test from "node:test";
import assert from "node:assert/strict";
import {
  auditPartnerIndexes,
  buildCreateIndexPlan,
  buildRollbackPlan,
  classifyIndexSpecs,
  parseArgs,
} from "../migrate_partner_game_membership_indexes.mjs";
import {
  PARTNER_MEMBERSHIP_COLLECTIONS,
  PARTNER_MEMBERSHIP_INDEX_SPECS,
} from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs";

const totalSpecs = Object.values(PARTNER_MEMBERSHIP_INDEX_SPECS).reduce((sum, specs) => sum + specs.length, 0);

const fakeDb = (indexesByCollection = {}, duplicates = []) => ({
  databaseName: "games",
  collection(name) {
    return {
      indexes: async () => indexesByCollection[name] ?? [],
      aggregate: () => ({ toArray: async () => duplicates }),
    };
  },
});

test("parseArgs accepts the documented modes and requires the apply confirmation", () => {
  assert.deepEqual(parseArgs([]), { mode: "audit", confirmApply: false });
  assert.equal(parseArgs(["--mode", "dry-run"]).mode, "dry-run");
  assert.equal(parseArgs(["--mode", "apply", "--confirm-apply"]).confirmApply, true);
  assert.equal(parseArgs(["--database", "games"]).database, "games");
  assert.throws(() => parseArgs(["--mode", "delete"]), /Unknown mode/);
  assert.throws(() => parseArgs(["--database"]), /Missing value/);
  assert.throws(() => parseArgs(["positional"]), /Unexpected argument/);
});

test("classifyIndexSpecs separates matching, missing and conflicting definitions", () => {
  const specs = [{ key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_game_id", unique: true }];
  assert.deepEqual(classifyIndexSpecs([
    { key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_game_id", unique: true },
  ], specs), { matching: ["uniq_tenant_game_id"], missing: [], conflicts: [] });
  assert.deepEqual(classifyIndexSpecs([], specs).missing, ["uniq_tenant_game_id"]);
  assert.deepEqual(classifyIndexSpecs([
    { key: { tenantKey: -1, id: 1 }, name: "uniq_tenant_game_id", unique: true },
  ], specs).conflicts, ["uniq_tenant_game_id:definition"]);
  assert.deepEqual(classifyIndexSpecs([
    { key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_game_id" },
  ], specs).conflicts, ["uniq_tenant_game_id:definition"]);
  assert.deepEqual(classifyIndexSpecs([
    { key: { tenantKey: 1, id: 1 }, name: "other_name", unique: true },
  ], specs).conflicts, ["uniq_tenant_game_id:equivalent-as-other_name"]);
});

test("classifyIndexSpecs compares sparse and ttl options too", () => {
  const sparseSpec = [{ key: { activeKey: 1 }, name: "uniq_partner_active_membership", unique: true, sparse: true }];
  assert.deepEqual(classifyIndexSpecs([
    { key: { activeKey: 1 }, name: "uniq_partner_active_membership", unique: true, sparse: true },
  ], sparseSpec).matching, ["uniq_partner_active_membership"]);
  assert.deepEqual(classifyIndexSpecs([
    { key: { activeKey: 1 }, name: "uniq_partner_active_membership", unique: true },
  ], sparseSpec).conflicts, ["uniq_partner_active_membership:definition"]);
  const ttlSpec = [{ key: { expiresAt: 1 }, name: "ttl_partner_nonce_expiry", expireAfterSeconds: 0 }];
  assert.deepEqual(classifyIndexSpecs([
    { key: { expiresAt: 1 }, name: "ttl_partner_nonce_expiry", expireAfterSeconds: 3600 },
  ], ttlSpec).conflicts, ["ttl_partner_nonce_expiry:definition"]);
});

test("an empty database requires every documented index and no duplicate games", async () => {
  const audit = await auditPartnerIndexes(fakeDb());
  assert.equal(audit.missing.length, totalSpecs);
  assert.deepEqual(audit.matching, []);
  assert.deepEqual(audit.conflicts, []);
  assert.deepEqual(audit.duplicateGames, []);
  const plan = buildCreateIndexPlan(audit);
  assert.equal(plan.length, totalSpecs);
  assert.deepEqual(plan[0], {
    collection: PARTNER_MEMBERSHIP_COLLECTIONS.nonces,
    createIndex: { expiresAt: 1 },
    options: { name: "ttl_partner_nonce_expiry", expireAfterSeconds: 0 },
  });
});

test("a fully migrated database plans nothing and reports no findings", async () => {
  const present = {};
  for (const [logical, specs] of Object.entries(PARTNER_MEMBERSHIP_INDEX_SPECS)) {
    present[PARTNER_MEMBERSHIP_COLLECTIONS[logical]] = specs.map(({ key, ...rest }) => ({ key, ...rest }));
  }
  const audit = await auditPartnerIndexes(fakeDb(present));
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.conflicts, []);
  assert.equal(audit.matching.length, totalSpecs);
  assert.deepEqual(buildCreateIndexPlan(audit), []);
});

test("a duplicate game identity is surfaced as a blocking finding", async () => {
  const audit = await auditPartnerIndexes(fakeDb({}, [{ _id: { tenantKey: null, id: "g-dup" }, count: 2 }]));
  assert.deepEqual(audit.duplicateGames, [{ _id: { tenantKey: null, id: "g-dup" }, count: 2 }]);
});

test("the rollback plan drops exactly the indexes this migration owns", () => {
  const operations = buildRollbackPlan();
  assert.equal(operations.length, totalSpecs);
  assert.ok(operations.some((item) => item.dropIndex === "uniq_tenant_game_id"));
  assert.ok(operations.every((item) => item.dropIndex !== "_id_"));
});

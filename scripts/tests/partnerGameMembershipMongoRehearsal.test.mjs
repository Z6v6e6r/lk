import assert from "node:assert/strict";
import test from "node:test";

import { validatePartnerMongoRehearsalTarget } from "../rehearse_partner_game_membership_mongo.mjs";

test("Mongo rehearsal target requires loopback replica discovery and an exact disposable database", () => {
  assert.deepEqual(validatePartnerMongoRehearsalTarget({
    mongoUri: "mongodb://127.0.0.1:27018,localhost:27019/?replicaSet=partner-test",
    databaseName: "lk_partner_rehearsal_ci01",
    acknowledgedDatabase: "lk_partner_rehearsal_ci01",
  }), {
    mongoUri: "mongodb://127.0.0.1:27018,localhost:27019/?replicaSet=partner-test",
    databaseName: "lk_partner_rehearsal_ci01",
    hosts: ["127.0.0.1", "localhost"],
    replicaSet: "partner-test",
  });

  for (const input of [
    {
      mongoUri: "mongodb://mongo.internal:27017/?replicaSet=prod",
      databaseName: "lk_partner_rehearsal_ci01",
      acknowledgedDatabase: "lk_partner_rehearsal_ci01",
    },
    {
      mongoUri: "mongodb://127.0.0.1:27017/?directConnection=true",
      databaseName: "lk_partner_rehearsal_ci01",
      acknowledgedDatabase: "lk_partner_rehearsal_ci01",
    },
    {
      mongoUri: "mongodb://127.0.0.1:27017/",
      databaseName: "lk_partner_rehearsal_ci01",
      acknowledgedDatabase: "lk_partner_rehearsal_ci01",
    },
    {
      mongoUri: "mongodb://127.0.0.1:27017/?replicaSet=partner-test",
      databaseName: "padlhub",
      acknowledgedDatabase: "padlhub",
    },
    {
      mongoUri: "mongodb://127.0.0.1:27017/?replicaSet=partner-test",
      databaseName: "lk_partner_rehearsal_ci01",
      acknowledgedDatabase: "lk_partner_rehearsal_other",
    },
  ]) assert.throws(() => validatePartnerMongoRehearsalTarget(input));
});

test("Mongo rehearsal parses topology options case-insensitively and rejects duplicates", () => {
  const base = {
    databaseName: "lk_partner_rehearsal_ci01",
    acknowledgedDatabase: "lk_partner_rehearsal_ci01",
  };
  assert.equal(validatePartnerMongoRehearsalTarget({
    ...base,
    mongoUri: "mongodb://127.0.0.1:27018/?REPLICASET=partner-test&DirectConnection=false",
  }).replicaSet, "partner-test");

  for (const mongoUri of [
    "mongodb://127.0.0.1:27018/?replicaSet=partner-test&DIRECTCONNECTION=true",
    "mongodb://127.0.0.1:27018/?replicaSet=partner-test&DirectConnection=TRUE",
    "mongodb://127.0.0.1:27018/?replicaSet=partner-test&%44irectConnection=true",
    "mongodb://127.0.0.1:27018/?replicaSet=partner-test&directConnection=false&DIRECTCONNECTION=true",
    "mongodb://127.0.0.1:27018/?replicaSet=partner-test&REPLICASET=partner-test",
  ]) {
    assert.throws(() => validatePartnerMongoRehearsalTarget({ ...base, mongoUri }));
  }
});

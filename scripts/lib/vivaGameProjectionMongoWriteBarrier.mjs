import { BSON } from "mongodb";

import { buildMongoTargetIdentity, canonicalJson, sha256 } from "./vivaGameProjectionCutoverContract.mjs";
import { hashCanonicalEjson } from "./vivaGameProjectionTenantMigrationExecution.mjs";

const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const buildMongoWriteBarrierValidator = (fenceTokenSha256) => ({
  $and: [
    { __padlhubVivaProjectionWriteBarrier: { $eq: fenceTokenSha256 } },
    { __padlhubVivaProjectionWriteBarrier: { $ne: fenceTokenSha256 } },
  ],
});

const canonicalEjsonSha256 = (value) => sha256(BSON.EJSON.stringify(value, null, 0, { relaxed: false }));

export async function readMongoWriteBarrierState(db, collectionName = "lk_games") {
  const rows = await db.listCollections({ name: collectionName }, { nameOnly: false }).toArray();
  if (rows.length !== 1) fail("Mongo write-barrier target collection is missing or ambiguous");
  const options = rows[0].options || {};
  return {
    validator: options.validator || {},
    validationLevel: options.validationLevel || "strict",
    validationAction: options.validationAction || "error",
  };
}

export async function assertMongoWriteBarrier(db, receipt, expected = {}) {
  if (!isObject(receipt) || receipt.formatVersion !== 1
    || receipt.kind !== "viva-game-projection-mongo-write-barrier-receipt"
    || receipt.state !== "HELD" || receipt.database !== "games" || receipt.collection !== "lk_games"
    || receipt.fenceTokenSha256 !== expected.fenceTokenSha256
    || receipt.cutoverPlanSha256 !== expected.cutoverPlanSha256
    || receipt.mongoTargetIdentitySha256 !== expected.mongoTargetIdentitySha256
    || receipt.applicationWriteProbeRejected !== true || receipt.migrationBypassProbeAborted !== true
    || receipt.releaseAuthorized !== false || receipt.releasedAt !== null) {
    fail("Mongo write-barrier receipt is not a held exact-cutover receipt");
  }
  const current = await readMongoWriteBarrierState(db);
  const validator = buildMongoWriteBarrierValidator(receipt.fenceTokenSha256);
  if (canonicalEjsonSha256(current.validator) !== receipt.barrierValidatorSha256
    || canonicalEjsonSha256(validator) !== receipt.barrierValidatorSha256
    || current.validationLevel !== "strict" || current.validationAction !== "error") {
    fail("Mongo write barrier is no longer installed exactly");
  }
  return true;
}

const abortQuietly = async (session) => {
  try { await session.abortTransaction(); } catch { /* the rejected command may already abort the transaction */ }
};

export async function installMongoWriteBarrier({
  migrationClient,
  applicationClient,
  applicationConnectionFingerprint,
  migrationConnectionFingerprint,
  replicaSetName,
  fenceTokenSha256,
  cutoverPlanSha256,
  installedAt = new Date().toISOString(),
}) {
  const migrationHello = await migrationClient.db("admin").command({ hello: 1 });
  const applicationHello = await applicationClient.db("admin").command({ hello: 1 });
  if (!migrationHello.setName || migrationHello.setName !== replicaSetName || applicationHello.setName !== replicaSetName) {
    fail("Mongo write-barrier principals do not resolve to the pinned replica set");
  }
  const target = buildMongoTargetIdentity({
    connectionFingerprint: applicationConnectionFingerprint,
    replicaSetName,
    database: "games",
    collection: "lk_games",
  });
  const db = migrationClient.db("games");
  const applicationDb = applicationClient.db("games");
  const previous = await readMongoWriteBarrierState(db);
  const validator = buildMongoWriteBarrierValidator(fenceTokenSha256);
  await db.command({ collMod: "lk_games", validator, validationLevel: "strict", validationAction: "error" });
  const installed = await readMongoWriteBarrierState(db);
  const barrierValidatorSha256 = canonicalEjsonSha256(validator);
  if (canonicalEjsonSha256(installed.validator) !== barrierValidatorSha256
    || installed.validationLevel !== "strict" || installed.validationAction !== "error") {
    fail("Mongo write barrier did not install exactly");
  }

  const probeDocument = await db.collection("lk_games").findOne({}, { projection: { _id: 1 } });
  if (!probeDocument?._id) fail("Mongo write barrier cannot be proven against an empty collection");
  let applicationWriteProbeRejected = false;
  const applicationSession = applicationClient.startSession();
  try {
    applicationSession.startTransaction();
    try {
      await applicationDb.collection("lk_games").updateOne(
        { _id: probeDocument._id },
        { $set: { __padlhubVivaProjectionBarrierProbe: fenceTokenSha256 } },
        { session: applicationSession, upsert: false },
      );
    } catch (error) {
      applicationWriteProbeRejected = error?.code === 121 || /document failed validation/i.test(String(error?.message || ""));
    }
    await abortQuietly(applicationSession);
  } finally {
    await applicationSession.endSession();
  }
  if (!applicationWriteProbeRejected) fail("Application Mongo principal is not denied by the write barrier");

  const migrationSession = migrationClient.startSession();
  let migrationBypassProbeAborted = false;
  try {
    migrationSession.startTransaction();
    const result = await db.collection("lk_games").updateOne(
      { _id: probeDocument._id },
      { $set: { __padlhubVivaProjectionBarrierProbe: fenceTokenSha256 } },
      { session: migrationSession, upsert: false, bypassDocumentValidation: true },
    );
    if (result?.acknowledged !== true || result.matchedCount !== 1) fail("Migration principal cannot bypass the write barrier exactly");
    await migrationSession.abortTransaction();
    migrationBypassProbeAborted = true;
  } finally {
    if (!migrationBypassProbeAborted) await abortQuietly(migrationSession);
    await migrationSession.endSession();
  }

  return {
    formatVersion: 1,
    kind: "viva-game-projection-mongo-write-barrier-receipt",
    state: "HELD",
    database: "games",
    collection: "lk_games",
    fenceTokenSha256,
    cutoverPlanSha256,
    mongoTargetIdentitySha256: target.targetIdentitySha256,
    applicationConnectionFingerprint,
    migrationConnectionFingerprint,
    replicaSetName,
    barrierValidatorSha256,
    previousValidationOptionsEjson: BSON.EJSON.stringify(previous, null, 0, { relaxed: false }),
    previousValidationOptionsSha256: canonicalEjsonSha256(previous),
    applicationWriteProbeRejected,
    migrationBypassProbeAborted,
    installedAt,
    releaseAuthorized: false,
    releasedAt: null,
  };
}

export async function hashLiveFullCollection(collection) {
  const rows = [];
  const cursor = collection.find({}, { projection: undefined }).sort({ _id: 1 });
  for await (const document of cursor) {
    if (!document?._id || typeof document._id.toHexString !== "function") {
      fail("Live full-collection verification requires ObjectId identities");
    }
    rows.push({ mongoId: document._id.toHexString(), documentSha256: hashCanonicalEjson(document) });
  }
  rows.sort((left, right) => left.mongoId.localeCompare(right.mongoId));
  if (new Set(rows.map(({ mongoId }) => mongoId)).size !== rows.length) fail("Live collection contains duplicate Mongo identities");
  return { documentCount: rows.length, fullCollectionStateSha256: sha256(canonicalJson(rows)) };
}

export function hashFullCollectionDocuments(documents) {
  if (!Array.isArray(documents)) fail("Full backup must be an array");
  const rows = documents.map((document) => {
    if (!document?._id || typeof document._id.toHexString !== "function") {
      fail("Full backup verification requires ObjectId identities");
    }
    return { mongoId: document._id.toHexString(), documentSha256: hashCanonicalEjson(document) };
  }).sort((left, right) => left.mongoId.localeCompare(right.mongoId));
  if (new Set(rows.map(({ mongoId }) => mongoId)).size !== rows.length) fail("Full backup contains duplicate Mongo identities");
  return { documentCount: rows.length, fullCollectionStateSha256: sha256(canonicalJson(rows)) };
}

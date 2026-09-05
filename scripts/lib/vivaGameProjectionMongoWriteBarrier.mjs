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
const normalizePrincipal = (value, label) => {
  const principal = { user: String(value?.user || ""), db: String(value?.db || "") };
  if (!principal.user || !principal.db) fail(`${label} Mongo principal is invalid`);
  return principal;
};
const normalizeRoles = (roles, label = "Mongo roles") => {
  if (!Array.isArray(roles)) fail(`${label} are invalid`);
  const normalized = roles.map((role) => ({ role: String(role?.role || ""), db: String(role?.db || "") }))
    .sort((left, right) => `${left.db}.${left.role}`.localeCompare(`${right.db}.${right.role}`));
  if (normalized.some((role) => !role.role || !role.db)
    || new Set(normalized.map((role) => `${role.db}\0${role.role}`)).size !== normalized.length) {
    fail(`${label} are invalid`);
  }
  return normalized;
};
const principalSha256 = (principal) => sha256(canonicalJson(normalizePrincipal(principal, "Application")));

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

export async function readAuthenticatedMongoPrincipal(client, label) {
  const status = await client.db("admin").command({ connectionStatus: 1, showPrivileges: true });
  const users = status?.authInfo?.authenticatedUsers;
  if (!Array.isArray(users) || users.length !== 1) fail(`${label} connection must authenticate exactly one Mongo principal`);
  return {
    principal: normalizePrincipal(users[0], label),
    roles: normalizeRoles(status?.authInfo?.authenticatedUserRoles || [], `${label} effective roles`),
    privileges: Array.isArray(status?.authInfo?.authenticatedUserPrivileges)
      ? status.authInfo.authenticatedUserPrivileges : [],
  };
}

export async function readStoredMongoUserRoles(adminClient, principal) {
  const normalized = normalizePrincipal(principal, "Stored application");
  const result = await adminClient.db(normalized.db).command({ usersInfo: normalized, showPrivileges: true });
  if (!Array.isArray(result?.users) || result.users.length !== 1) fail("Application Mongo user record is missing or ambiguous");
  const user = result.users[0];
  if (user.user !== normalized.user || user.db !== normalized.db) fail("Application Mongo user readback changed identity");
  return normalizeRoles(user.roles || [], "Stored application roles");
}

async function updateStoredMongoUserRoles(adminClient, principal, roles) {
  const normalized = normalizePrincipal(principal, "Application");
  await adminClient.db(normalized.db).command({ updateUser: normalized.user, roles: normalizeRoles(roles) });
  const readback = await readStoredMongoUserRoles(adminClient, normalized);
  if (canonicalEjsonSha256(readback) !== canonicalEjsonSha256(normalizeRoles(roles))) {
    fail("Application Mongo role update did not read back exactly");
  }
  return readback;
}

const abortQuietly = async (session) => {
  try { await session.abortTransaction(); } catch { /* a rejected command can already abort the transaction */ }
};
const isUnauthorized = (error) => error?.code === 13 || /not authorized|unauthorized/i.test(String(error?.message || ""));
const expectUnauthorized = async (action, label) => {
  try { await action(); } catch (error) {
    if (isUnauthorized(error)) return true;
    throw error;
  }
  fail(`Application Mongo principal unexpectedly passed the ${label} denial probe`);
};

async function probeApplicationPrincipalDenied(applicationClient, probeDocument, fenceTokenSha256) {
  const db = applicationClient.db("games");
  const collection = db.collection("lk_games");
  const transactionalProbe = async (label, action) => {
    const session = applicationClient.startSession();
    try {
      session.startTransaction();
      await expectUnauthorized(() => action(session), label);
      await abortQuietly(session);
    } finally {
      await session.endSession();
    }
  };
  await transactionalProbe("insert", (session) => collection.insertOne(
    { _id: `__padlhub_barrier_probe_${fenceTokenSha256}` }, { session },
  ));
  await transactionalProbe("update", (session) => collection.updateOne(
    { _id: probeDocument._id }, { $set: { __padlhubVivaProjectionBarrierProbe: fenceTokenSha256 } }, { session, upsert: false },
  ));
  await transactionalProbe("delete", (session) => collection.deleteOne({ _id: probeDocument._id }, { session }));
  await expectUnauthorized(
    () => db.command({ drop: `__padlhub_barrier_probe_${fenceTokenSha256.slice(0, 16)}` }), "drop",
  );
  await expectUnauthorized(() => applicationClient.db("admin").command({
    renameCollection: `games.__padlhub_barrier_probe_${fenceTokenSha256.slice(0, 16)}`,
    to: `games.__padlhub_barrier_probe_to_${fenceTokenSha256.slice(0, 16)}`,
  }), "renameCollection");
  await expectUnauthorized(() => db.command({
    collMod: `__padlhub_barrier_probe_${fenceTokenSha256.slice(0, 16)}`, validator: {},
  }), "collMod");
  return {
    applicationInsertProbeRejected: true,
    applicationUpdateProbeRejected: true,
    applicationDeleteProbeRejected: true,
    applicationDropProbeRejected: true,
    applicationRenameProbeRejected: true,
    applicationCollModProbeRejected: true,
  };
}

const assertReceiptIdentity = (receipt, expected) => {
  if (!isObject(receipt) || receipt.formatVersion !== 1
    || !["viva-game-projection-mongo-write-barrier-receipt", "viva-game-projection-mongo-write-barrier-preparation"].includes(receipt.kind)
    || receipt.database !== "games" || receipt.collection !== "lk_games"
    || receipt.fenceTokenSha256 !== expected.fenceTokenSha256
    || receipt.cutoverPlanSha256 !== expected.cutoverPlanSha256
    || receipt.mongoTargetIdentitySha256 !== expected.mongoTargetIdentitySha256
    || principalSha256(receipt.applicationPrincipal) !== receipt.applicationPrincipalSha256
    || receipt.applicationConnectionFingerprint === receipt.migrationConnectionFingerprint) {
    fail("Mongo write-barrier artifact does not bind the exact cutover and separate principals");
  }
};

export async function assertMongoWriteBarrier(migrationClient, receipt, expected = {}) {
  assertReceiptIdentity(receipt, expected);
  if (receipt.kind !== "viva-game-projection-mongo-write-barrier-receipt" || receipt.state !== "HELD"
    || receipt.applicationRolesRevoked !== true || receipt.applicationRolesReadbackEmpty !== true
    || receipt.applicationInsertProbeRejected !== true || receipt.applicationUpdateProbeRejected !== true
    || receipt.applicationDeleteProbeRejected !== true || receipt.applicationDropProbeRejected !== true
    || receipt.applicationRenameProbeRejected !== true || receipt.applicationCollModProbeRejected !== true
    || receipt.migrationBypassProbeAborted !== true || receipt.releaseAuthorized !== false || receipt.releasedAt !== null) {
    fail("Mongo write-barrier receipt is not a held exact-cutover receipt");
  }
  const current = await readMongoWriteBarrierState(migrationClient.db("games"));
  const validator = buildMongoWriteBarrierValidator(receipt.fenceTokenSha256);
  if (canonicalEjsonSha256(current.validator) !== receipt.barrierValidatorSha256
    || canonicalEjsonSha256(validator) !== receipt.barrierValidatorSha256
    || current.validationLevel !== "strict" || current.validationAction !== "error") {
    fail("Mongo document-validation barrier is no longer installed exactly");
  }
  const roles = await readStoredMongoUserRoles(migrationClient, receipt.applicationPrincipal);
  if (roles.length !== 0) fail("Application Mongo ACL barrier is no longer held");
  return true;
}

export async function installMongoWriteBarrier({
  migrationClient,
  applicationClient,
  applicationConnectionFingerprint,
  migrationConnectionFingerprint,
  replicaSetName,
  fenceTokenSha256,
  cutoverPlanSha256,
  installedAt = new Date().toISOString(),
  beforeInstall = async () => {},
}) {
  if (applicationConnectionFingerprint === migrationConnectionFingerprint) {
    fail("Application and migration Mongo connections must be separately pinned");
  }
  const migrationHello = await migrationClient.db("admin").command({ hello: 1 });
  const applicationHello = await applicationClient.db("admin").command({ hello: 1 });
  if (!migrationHello.setName || migrationHello.setName !== replicaSetName || applicationHello.setName !== replicaSetName) {
    fail("Mongo write-barrier principals do not resolve to the pinned replica set");
  }
  const applicationAuth = await readAuthenticatedMongoPrincipal(applicationClient, "Application");
  const migrationAuth = await readAuthenticatedMongoPrincipal(migrationClient, "Migration");
  if (applicationAuth.principal.user === migrationAuth.principal.user && applicationAuth.principal.db === migrationAuth.principal.db) {
    fail("Application and migration Mongo principals must be distinct");
  }
  const previousApplicationRoles = await readStoredMongoUserRoles(migrationClient, applicationAuth.principal);
  if (previousApplicationRoles.length === 0) fail("Application Mongo principal has no restorable roles");
  const target = buildMongoTargetIdentity({
    connectionFingerprint: applicationConnectionFingerprint,
    replicaSetName,
    database: "games",
    collection: "lk_games",
  });
  const db = migrationClient.db("games");
  const previous = await readMongoWriteBarrierState(db);
  const validator = buildMongoWriteBarrierValidator(fenceTokenSha256);
  const barrierValidatorSha256 = canonicalEjsonSha256(validator);
  const previousValidationOptionsEjson = BSON.EJSON.stringify(previous, null, 0, { relaxed: false });
  const previousValidationOptionsSha256 = canonicalEjsonSha256(previous);
  const previousApplicationRolesEjson = BSON.EJSON.stringify(previousApplicationRoles, null, 0, { relaxed: false });
  const previousApplicationRolesSha256 = canonicalEjsonSha256(previousApplicationRoles);
  await beforeInstall({
    formatVersion: 1,
    kind: "viva-game-projection-mongo-write-barrier-preparation",
    state: "PREPARED_BEFORE_ACL_AND_COLLMOD",
    database: "games",
    collection: "lk_games",
    fenceTokenSha256,
    cutoverPlanSha256,
    mongoTargetIdentitySha256: target.targetIdentitySha256,
    applicationConnectionFingerprint,
    migrationConnectionFingerprint,
    applicationPrincipal: applicationAuth.principal,
    applicationPrincipalSha256: principalSha256(applicationAuth.principal),
    migrationPrincipal: migrationAuth.principal,
    replicaSetName,
    barrierValidatorSha256,
    previousValidationOptionsEjson,
    previousValidationOptionsSha256,
    previousApplicationRolesEjson,
    previousApplicationRolesSha256,
    preparedAt: installedAt,
  });

  await updateStoredMongoUserRoles(migrationClient, applicationAuth.principal, []);
  const applicationRolesReadback = await readAuthenticatedMongoPrincipal(applicationClient, "Application after ACL barrier");
  if (applicationRolesReadback.roles.length !== 0 || applicationRolesReadback.privileges.length !== 0) {
    fail("Application Mongo principal retained effective roles or privileges after ACL barrier");
  }
  await db.command({ collMod: "lk_games", validator, validationLevel: "strict", validationAction: "error" });
  const installed = await readMongoWriteBarrierState(db);
  if (canonicalEjsonSha256(installed.validator) !== barrierValidatorSha256
    || installed.validationLevel !== "strict" || installed.validationAction !== "error") {
    fail("Mongo document-validation barrier did not install exactly");
  }

  const probeDocument = await db.collection("lk_games").findOne({}, { projection: { _id: 1 } });
  if (!probeDocument?._id) fail("Mongo write barrier cannot be proven against an empty collection");
  const denialProof = await probeApplicationPrincipalDenied(applicationClient, probeDocument, fenceTokenSha256);

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
    applicationPrincipal: applicationAuth.principal,
    applicationPrincipalSha256: principalSha256(applicationAuth.principal),
    migrationPrincipal: migrationAuth.principal,
    replicaSetName,
    barrierValidatorSha256,
    previousValidationOptionsEjson,
    previousValidationOptionsSha256,
    previousApplicationRolesEjson,
    previousApplicationRolesSha256,
    applicationRolesRevoked: true,
    applicationRolesReadbackEmpty: true,
    ...denialProof,
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

const parsePreparedPreimage = (artifact) => {
  let previous;
  let roles;
  try {
    previous = BSON.EJSON.parse(artifact.previousValidationOptionsEjson, { relaxed: false });
    roles = BSON.EJSON.parse(artifact.previousApplicationRolesEjson, { relaxed: false });
  } catch { fail("Mongo write-barrier recovery preimage is invalid canonical EJSON"); }
  const normalizedRoles = normalizeRoles(roles, "Previous application roles");
  if (canonicalEjsonSha256(previous) !== artifact.previousValidationOptionsSha256
    || canonicalEjsonSha256(normalizedRoles) !== artifact.previousApplicationRolesSha256
    || !isObject(previous.validator)
    || !["off", "strict", "moderate"].includes(previous.validationLevel)
    || !["error", "warn"].includes(previous.validationAction)) {
    fail("Mongo write-barrier recovery preimage failed validation");
  }
  return { previous, roles: normalizedRoles };
};

export async function restorePreviousMongoWriteBarrier(migrationClient, artifact, expected) {
  assertReceiptIdentity(artifact, expected);
  if (typeof expected?.assertFence !== "function") {
    fail("Mongo write-barrier recovery requires a continuous fence callback");
  }
  const { previous, roles } = parsePreparedPreimage(artifact);
  const db = migrationClient.db("games");
  await expected.assertFence("BEFORE_RECOVERY_STATE_READ");
  const current = await readMongoWriteBarrierState(db);
  const currentStateSha256 = canonicalEjsonSha256(current);
  const expectedBarrierStateSha256 = canonicalEjsonSha256({
    validator: buildMongoWriteBarrierValidator(artifact.fenceTokenSha256),
    validationLevel: "strict",
    validationAction: "error",
  });
  if (![artifact.previousValidationOptionsSha256, expectedBarrierStateSha256].includes(currentStateSha256)) {
    fail("Mongo validation state drifted beyond the prepared barrier or its exact preimage");
  }
  const currentRoles = await readStoredMongoUserRoles(migrationClient, artifact.applicationPrincipal);
  const currentRolesSha256 = canonicalEjsonSha256(currentRoles);
  const emptyRolesSha256 = canonicalEjsonSha256([]);
  if (![artifact.previousApplicationRolesSha256, emptyRolesSha256].includes(currentRolesSha256)) {
    fail("Application Mongo roles drifted beyond the prepared ACL barrier or their exact preimage");
  }
  if (currentStateSha256 === expectedBarrierStateSha256) {
    await expected.assertFence("BEFORE_VALIDATOR_RESTORE");
    await db.command({
      collMod: "lk_games",
      validator: previous.validator,
      validationLevel: previous.validationLevel,
      validationAction: previous.validationAction,
    });
    await expected.assertFence("AFTER_VALIDATOR_RESTORE");
  }
  if (currentRolesSha256 === emptyRolesSha256) {
    await expected.assertFence("BEFORE_APPLICATION_ROLES_RESTORE");
    await updateStoredMongoUserRoles(migrationClient, artifact.applicationPrincipal, roles);
    await expected.assertFence("AFTER_APPLICATION_ROLES_RESTORE");
  }
  const restored = await readMongoWriteBarrierState(db);
  const restoredRoles = await readStoredMongoUserRoles(migrationClient, artifact.applicationPrincipal);
  if (canonicalEjsonSha256(restored) !== artifact.previousValidationOptionsSha256
    || canonicalEjsonSha256(restoredRoles) !== artifact.previousApplicationRolesSha256) {
    fail("Mongo write-barrier preimage was not restored exactly");
  }
  await expected.assertFence("AFTER_RECOVERY_READBACK");
  return {
    formatVersion: 1,
    kind: "viva-game-projection-mongo-write-barrier-recovery-receipt",
    state: "RELEASED_TO_EXACT_PREIMAGE",
    sourceArtifactKind: artifact.kind,
    fenceTokenSha256: artifact.fenceTokenSha256,
    cutoverPlanSha256: artifact.cutoverPlanSha256,
    mongoTargetIdentitySha256: artifact.mongoTargetIdentitySha256,
    applicationPrincipalSha256: artifact.applicationPrincipalSha256,
    restoredValidationOptionsSha256: artifact.previousValidationOptionsSha256,
    restoredApplicationRolesSha256: artifact.previousApplicationRolesSha256,
    releasedAt: new Date().toISOString(),
  };
}

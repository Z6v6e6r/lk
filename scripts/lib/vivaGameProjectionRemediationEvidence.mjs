import { BSON, ObjectId } from "mongodb";

import { canonicalJson, sha256 } from "./vivaGameProjectionCutoverContract.mjs";
import { validateMigrationPlanBundle } from "./vivaGameProjectionRemediationExecution.mjs";
import { classifyLegacyTenantMigrationGame } from "./vivaGameProjectionTenantMigration.mjs";
import { hashCanonicalEjson } from "./vivaGameProjectionTenantMigrationExecution.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const ACTIVE_PROVIDER_STATES = new Set(["ACTIVE", "OPEN", "SCHEDULED", "BOOKED"]);
const fail = (message) => { throw new Error(message); };

const text = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const normalizeTime = (value) => {
  const match = text(value)?.match(/(?:T|^)(\d{2}:\d{2})(?::\d{2})?/);
  return match?.[1] || null;
};

const addDays = (date, days) => {
  if (!DATE_RE.test(String(date || ""))) fail("Remediation capture date is invalid");
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const isCancelledState = (value) => /CANCEL|DELETE|ARCHIVE|VOID/i.test(text(value) || "");

const exactlyOne = (values, label, validator = (value) => Boolean(value)) => {
  const unique = [...new Set(values.map((value) => text(value)).filter(Boolean))];
  if (unique.length !== 1 || !validator(unique[0])) fail(`Viva remediation provider ${label} aliases are ambiguous`);
  return unique[0];
};

export function normalizeVivaRemediationProviderRow(row) {
  const id = exactlyOne([row?.id, row?.exerciseId, row?.uuid], "exercise identity", (value) => UUID_RE.test(value));
  const studioId = exactlyOne([
    row?.studio?.id, row?.studio?.uuid, row?.studioId,
    row?.station?.id, row?.station?.uuid, row?.stationId,
  ], "studio identity");
  const date = exactlyOne([
    row?.date,
    row?.booking?.date,
    ...[row?.timeFrom, row?.startTime, row?.timeTo, row?.endTime]
      .map((value) => text(value)?.slice(0, 10)).filter((value) => DATE_RE.test(value || "")),
  ], "date", (value) => DATE_RE.test(value));
  const timeFrom = exactlyOne([
    normalizeTime(row?.timeFrom), normalizeTime(row?.startTime), normalizeTime(row?.booking?.timeFrom),
  ], "start time");
  const timeTo = exactlyOne([
    normalizeTime(row?.timeTo), normalizeTime(row?.endTime), normalizeTime(row?.booking?.timeTo),
  ], "end time");
  const lifecycleSignals = [row?.exerciseStatus, row?.status, row?.state, row?.lifecycleStatus]
    .map((value) => text(value)?.toUpperCase()).filter(Boolean);
  const lifecycleKinds = lifecycleSignals.map((value) => {
    if (ACTIVE_PROVIDER_STATES.has(value)) return "ACTIVE";
    if (isCancelledState(value)) return "CANCELLED";
    fail("Viva remediation provider lifecycle is unknown");
  });
  if (row?.active === true) lifecycleKinds.push("ACTIVE");
  if (row?.active === false || row?.isCancelled === true || row?.cancelled === true || row?.canceled === true) {
    lifecycleKinds.push("CANCELLED");
  }
  const lifecycle = exactlyOne(lifecycleKinds, "lifecycle");
  const uniqueStatuses = [...new Set(lifecycleSignals)];
  if (uniqueStatuses.length > 1) fail("Viva remediation provider lifecycle aliases are ambiguous");
  const cancelled = lifecycle === "CANCELLED";
  const active = lifecycle === "ACTIVE";
  const status = uniqueStatuses[0] || lifecycle;
  return {
    id,
    exerciseId: id,
    studio: { id: studioId },
    studioId,
    date,
    timeFrom,
    timeTo,
    status,
    isCancelled: cancelled,
    cancelled,
    active,
  };
}

export function remediationCaptureDates(documents, windowDays = 7) {
  if (!Array.isArray(documents) || documents.length < 1 || windowDays !== 7) {
    fail("Remediation capture requires a non-empty seven-day review scope");
  }
  const dates = new Set();
  for (const document of documents) {
    const date = document?.booking?.date;
    if (!DATE_RE.test(String(date || ""))) fail("Remediation document date is invalid");
    for (let offset = -windowDays; offset <= windowDays; offset += 1) dates.add(addDays(date, offset));
  }
  if (dates.size > 31) fail("Remediation provider capture date range exceeds the bounded window");
  return [...dates].sort();
}

const identitySignals = (document) => [...new Set([
  document?.booking?.vivaExerciseId,
  document?.booking?.exerciseId,
  document?.metadata?.vivaExerciseId,
  document?.metadata?.exerciseId,
  String(document?.dedupeKey || "").startsWith("viva:") ? String(document.dedupeKey).slice(5) : null,
].map((value) => text(value)).filter(Boolean))].sort();

const providerIdentitySignalsSha256 = (document) => sha256(canonicalJson(identitySignals(document)));

const referenceSafeIdentityRepair = (document, providerId) => {
  const dedupeId = String(document?.dedupeKey || "").startsWith("viva:")
    ? String(document.dedupeKey).slice(5) : null;
  const preserved = [document?.booking?.vivaExerciseId, document?.booking?.exerciseId, dedupeId]
    .map((value) => text(value));
  const metadata = [document?.metadata?.vivaExerciseId, document?.metadata?.exerciseId]
    .map((value) => text(value));
  return preserved.every((value) => value === providerId)
    && metadata.some((value) => value !== providerId);
};

const exactSlot = (document, row) => row.date === document.booking.date
  && row.studioId === document.booking.studioId
  && row.timeFrom === document.booking.timeFrom
  && row.timeTo === document.booking.timeTo;

const sameDateStudio = (document, row) => row.date === document.booking.date
  && row.studioId === document.booking.studioId;

const cloneBson = (value) => BSON.EJSON.parse(
  BSON.EJSON.stringify(value, null, 0, { relaxed: false }),
  { relaxed: false },
);

const assertMaterializedPostimageEligible = (document, classified, providerRows, tenantKey) => {
  if (!new Set(["RECONCILE_PROVIDER_TIME", "REPAIR_METADATA_IDENTITY"]).has(classified.category)) return;
  const postimage = cloneBson(document);
  postimage._id = { $oid: document._id.toHexString() };
  if (classified.category === "RECONCILE_PROVIDER_TIME") {
    postimage.booking.timeFrom = classified.evidence.timeFrom;
    postimage.booking.timeTo = classified.evidence.timeTo;
  } else {
    postimage.metadata = postimage.metadata && typeof postimage.metadata === "object" ? postimage.metadata : {};
    postimage.metadata.vivaExerciseId = classified.evidence.exerciseId;
    postimage.metadata.exerciseId = classified.evidence.exerciseId;
  }
  const date = postimage?.booking?.date;
  const result = classifyLegacyTenantMigrationGame(postimage, providerRows, {
    tenantKey,
    dateFrom: date,
    dateTo: date,
    operationId: `remediation-postcheck-${document._id.toHexString()}`,
  });
  if (!result.eligible || result.reason !== "PROVIDER_IDENTITY_CONFIRMED") {
    fail(`Remediation postimage is not tenant-migration eligible for Mongo document ${document._id.toHexString()}`);
  }
};

function classifySkippedDocument(document, providerRows) {
  const signals = identitySignals(document);
  const matches = providerRows.filter((row) => signals.includes(row.exerciseId));
  const activeMatches = matches.filter((row) => row.active && !row.cancelled);
  const recordedDateMatches = matches.filter((row) => row.date === document.booking.date);
  const cancelledExact = matches.filter((row) => row.cancelled && exactSlot(document, row));
  if (cancelledExact.length === 1 && matches.length === 1) {
    const row = cancelledExact[0];
    return {
      category: "CANCEL_AND_ARCHIVE",
      review: {
        reviewResult: "CANCELLED_READBACK_CONFIRMED",
        providerMatchCount: 1,
        providerRecordedDateMatchCount: 1,
        providerActiveMatchCount: 0,
      },
      evidence: {
        exerciseId: row.exerciseId,
        date: row.date,
        studioId: row.studioId,
        timeFrom: row.timeFrom,
        timeTo: row.timeTo,
        identitySignalsSha256: providerIdentitySignalsSha256(document),
        slotMatchCount: 1,
        status: row.status,
        cancelled: true,
        active: false,
      },
    };
  }
  if (matches.length === 0) {
    return {
      category: "QUARANTINE_AND_ARCHIVE",
      review: {
        reviewResult: "PROVIDER_ABSENT_WITHIN_PLUS_MINUS_7_DAYS",
        providerMatchCount: 0,
        providerRecordedDateMatchCount: 0,
        providerActiveMatchCount: 0,
      },
      evidence: {
        recordedDate: document.booking.date,
        studioId: document.booking.studioId,
        timeFrom: document.booking.timeFrom,
        timeTo: document.booking.timeTo,
        identitySignalsSha256: providerIdentitySignalsSha256(document),
        searchWindowDays: 7,
        matchCount: 0,
      },
    };
  }
  if (activeMatches.length === 1 && matches.length === 1 && sameDateStudio(document, activeMatches[0])
    && !exactSlot(document, activeMatches[0])) {
    const row = activeMatches[0];
    return {
      category: "RECONCILE_PROVIDER_TIME",
      review: {
        reviewResult: "EXACT_EXERCISE_SAME_DATE_STUDIO_TIME_CHANGED",
        providerMatchCount: 1,
        providerRecordedDateMatchCount: recordedDateMatches.length,
        providerActiveMatchCount: 1,
      },
      evidence: {
        exerciseId: row.exerciseId,
        date: row.date,
        studioId: row.studioId,
        timeFrom: row.timeFrom,
        timeTo: row.timeTo,
        cancelled: false,
        active: true,
      },
    };
  }
  const exactActive = activeMatches.filter((row) => exactSlot(document, row));
  const activeSignalIds = new Set(activeMatches.map((row) => row.exerciseId));
  if (signals.length > 1 && exactActive.length === 1 && activeSignalIds.size === 1
    && referenceSafeIdentityRepair(document, exactActive[0].exerciseId)) {
    const row = exactActive[0];
    return {
      category: "REPAIR_METADATA_IDENTITY",
      review: {
        reviewResult: "ONE_IDENTITY_SIGNAL_HAS_UNIQUE_EXACT_PROVIDER_SLOT",
        providerMatchCount: matches.length,
        providerRecordedDateMatchCount: recordedDateMatches.length,
        providerActiveMatchCount: activeMatches.length,
      },
      evidence: {
        exerciseId: row.exerciseId,
        date: row.date,
        studioId: row.studioId,
        timeFrom: row.timeFrom,
        timeTo: row.timeTo,
        cancelled: false,
        active: true,
      },
      identity: {
        rootGameIdChangeRequired: false,
        referenceRewriteRequired: false,
        fieldsToSet: {
          "metadata.vivaExerciseId": row.exerciseId,
          "metadata.exerciseId": row.exerciseId,
        },
      },
    };
  }
  fail(`Remediation evidence remains ambiguous for Mongo document ${document._id.toHexString()}`);
}

const jsonArtifact = (value) => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  return { value, bytes, sha256: sha256(bytes) };
};

const parseFullBackup = (bytes) => {
  let documents;
  try { documents = BSON.EJSON.parse(bytes.toString("utf8"), { relaxed: false }); }
  catch { fail("Remediation full backup is not canonical EJSON"); }
  if (!Array.isArray(documents) || documents.length < 1
    || documents.some((document) => !(document?._id instanceof ObjectId))) {
    fail("Remediation full backup lacks BSON ObjectId documents");
  }
  return documents;
};

const isActiveLegacyDocument = (document, dateFrom) => document?.archived !== true
  && !new Set(["CANCELLED", "CANCELED"]).has(String(document?.status || ""))
  && (document?.tenantKey === null || document?.tenantKey === undefined)
  && (document?.revision === null || document?.revision === undefined)
  && typeof document?.booking?.date === "string" && document.booking.date >= dateFrom
  && typeof document?.booking?.timeFrom === "string" && document.booking.timeFrom !== ""
  && typeof document?.booking?.timeTo === "string" && document.booking.timeTo !== ""
  && typeof document?.booking?.studioId === "string" && document.booking.studioId !== "";

export function selectRemediationSkippedDocuments({
  cutoverPlan, migrationPlanBundle, migrationPlanBundleBytes, fullBackupBytes,
} = {}) {
  if (cutoverPlan?.kind !== "viva-game-projection-tenant-cutover-plan"
    || !Buffer.isBuffer(migrationPlanBundleBytes) || !Buffer.isBuffer(fullBackupBytes)) {
    fail("Remediation skipped-scope inputs are incomplete");
  }
  const documents = parseFullBackup(fullBackupBytes);
  const activeLegacy = documents.filter((document) => (
    isActiveLegacyDocument(document, cutoverPlan.migration?.futureBoundaryDate)
  ));
  const eligibleIds = validateMigrationPlanBundle({
    value: migrationPlanBundle,
    bytes: migrationPlanBundleBytes,
  }, cutoverPlan);
  const eligibleSet = new Set(eligibleIds);
  const skipped = activeLegacy.filter((document) => !eligibleSet.has(document._id.toHexString()));
  if (eligibleIds.length !== cutoverPlan.migration?.totalEligible
    || skipped.length !== cutoverPlan.migration?.totalSkipped
    || activeLegacy.length !== eligibleIds.length + skipped.length
    || skipped.length < 1 || skipped.length > 100) {
    fail("Remediation skipped scope differs from the exact cutover plan");
  }
  return skipped.sort((left, right) => left._id.toHexString().localeCompare(right._id.toHexString()));
}

export function buildVivaGameProjectionRemediationEvidence({
  cutoverPlan,
  migrationPlanBundle,
  migrationPlanBundleBytes,
  fullBackupBytes,
  mongoDocuments,
  providerRows,
  captureSessionId,
  tenantKey,
  servicePrincipalSha256,
  fenceTokenSha256,
  providerCapturedAt,
  mongoCapturedAt,
  providerCapturePasses,
} = {}) {
  if (cutoverPlan?.kind !== "viva-game-projection-tenant-cutover-plan"
    || cutoverPlan.state !== "READY_FOR_SEPARATE_LIVE_APPROVAL"
    || !Buffer.isBuffer(migrationPlanBundleBytes) || !Buffer.isBuffer(fullBackupBytes)
    || !/^[A-Za-z0-9._:-]{16,128}$/.test(String(captureSessionId || ""))
    || !tenantKey || sha256(tenantKey) !== cutoverPlan.tenantKeySha256
    || !HASH_RE.test(String(servicePrincipalSha256 || ""))
    || fenceTokenSha256 !== cutoverPlan.writerFence?.fenceTokenSha256
    || !Number.isFinite(Date.parse(providerCapturedAt)) || !Number.isFinite(Date.parse(mongoCapturedAt))
    || !Array.isArray(providerCapturePasses) || providerCapturePasses.length !== 2
    || providerCapturePasses.some((pass, index) => pass?.pass !== index + 1
      || !Array.isArray(pass.dates) || !HASH_RE.test(String(pass.canonicalRowsSha256 || ""))
      || !HASH_RE.test(String(pass.captureTreeSha256 || "")))) {
    fail("Remediation evidence binding is incomplete");
  }
  const skipped = selectRemediationSkippedDocuments({
    cutoverPlan, migrationPlanBundle, migrationPlanBundleBytes, fullBackupBytes,
  });
  const currentById = new Map((mongoDocuments || []).map((document) => [document?._id?.toHexString?.(), document]));
  if (currentById.size !== skipped.length) fail("Remediation Mongo capture count differs from skipped scope");
  const normalizedRows = (providerRows || []).map((row) => normalizeVivaRemediationProviderRow(row))
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const normalizedRowsSha256 = sha256(canonicalJson(normalizedRows));
  const providerCaptureTree = (pass) => sha256(canonicalJson(pass.dates.map(({
    date, rowCount, canonicalRowsSha256,
  }) => ({ date, rowCount, canonicalRowsSha256 }))));
  if (providerCapturePasses.some((pass) => (
    pass.canonicalRowsSha256 !== normalizedRowsSha256
    || pass.captureTreeSha256 !== providerCaptureTree(pass)
    || pass.dates.some((entry) => !DATE_RE.test(String(entry?.date || ""))
      || !Number.isSafeInteger(entry?.rowCount) || entry.rowCount < 0
      || !HASH_RE.test(String(entry?.rawPayloadSha256 || ""))
      || !HASH_RE.test(String(entry?.canonicalRowsSha256 || "")))
  ))
    || providerCapturePasses[0].canonicalRowsSha256 !== providerCapturePasses[1].canonicalRowsSha256
    || canonicalJson(providerCapturePasses[0].dates.map(({ date, rowCount, canonicalRowsSha256 }) => ({
      date, rowCount, canonicalRowsSha256,
    }))) !== canonicalJson(providerCapturePasses[1].dates.map(({ date, rowCount, canonicalRowsSha256 }) => ({
      date, rowCount, canonicalRowsSha256,
    })))) {
    fail("Remediation evidence lacks two stable complete provider capture passes");
  }
  const prepared = skipped.map((document) => {
    const mongoId = document._id.toHexString();
    if (typeof document.id !== "string" || !document.id.trim()) {
      fail(`Remediation root game identity is missing for ${mongoId}`);
    }
    const current = currentById.get(mongoId);
    const preimageSha256 = hashCanonicalEjson(document);
    if (!current || hashCanonicalEjson(current) !== preimageSha256) {
      fail(`Remediation Mongo preimage drifted for ${mongoId}`);
    }
    const classified = classifySkippedDocument(document, normalizedRows);
    assertMaterializedPostimageEligible(document, classified, normalizedRows, tenantKey);
    const providerEvidenceSha256 = sha256(canonicalJson(classified.evidence));
    const itemFingerprint = sha256(canonicalJson({ captureSessionId, mongoId, preimageSha256 }));
    return { document, mongoId, preimageSha256, providerEvidenceSha256, itemFingerprint, ...classified };
  }).sort((left, right) => left.mongoId.localeCompare(right.mongoId));

  const packet = jsonArtifact({
    formatVersion: 2,
    kind: "viva-game-projection-remediation-review-packet",
    captureSessionId,
    sourceFlowSha256: cutoverPlan.sourceFlowSha256,
    tenantKey,
    servicePrincipalSha256,
    executionAuthorized: false,
    remediationItems: prepared.map((item) => ({
      itemFingerprint: item.itemFingerprint,
      category: item.category,
      mongoId: item.mongoId,
      rootGameId: item.document.id,
      preimageSha256: item.preimageSha256,
      providerEvidenceSha256: item.providerEvidenceSha256,
    })),
  });
  const providerCapture = jsonArtifact({
    formatVersion: 1,
    kind: "viva-admin-remediation-provider-capture",
    captureSessionId,
    servicePrincipalSha256,
    fenceTokenSha256,
    capturedAt: providerCapturedAt,
    stablePasses: providerCapturePasses,
    records: prepared.map((item) => ({
      itemFingerprint: item.itemFingerprint,
      category: item.category,
      evidence: item.evidence,
      evidenceSha256: item.providerEvidenceSha256,
    })),
  });
  const enrichment = jsonArtifact({
    formatVersion: 2,
    kind: "viva-game-projection-remediation-manual-review",
    packetSha256: packet.sha256,
    providerCaptureSha256: providerCapture.sha256,
    captureSessionId,
    sourceFlowSha256: cutoverPlan.sourceFlowSha256,
    tenantKeySha256: cutoverPlan.tenantKeySha256,
    servicePrincipalSha256,
    capturedAt: providerCapturedAt,
    executionAuthorized: false,
    reviews: prepared.map((item) => ({
      itemFingerprint: item.itemFingerprint,
      providerEvidenceSha256: item.providerEvidenceSha256,
      ...item.review,
    })),
  });
  const identityAudit = jsonArtifact({
    formatVersion: 2,
    kind: "viva-game-projection-identity-reference-audit",
    packetSha256: packet.sha256,
    enrichmentSha256: enrichment.sha256,
    captureSessionId,
    sourceFlowSha256: cutoverPlan.sourceFlowSha256,
    executionAuthorized: false,
    results: prepared.filter((item) => item.identity).map((item) => ({
      itemFingerprint: item.itemFingerprint,
      ...item.identity,
    })),
  });
  const mongoCapture = jsonArtifact({
    formatVersion: 1,
    kind: "viva-game-projection-remediation-mongo-capture",
    captureSessionId,
    sourceFlowSha256: cutoverPlan.sourceFlowSha256,
    fenceTokenSha256,
    mongoTargetIdentitySha256: cutoverPlan.mongoTarget?.targetIdentitySha256,
    capturedAt: mongoCapturedAt,
    records: prepared.map((item) => ({
      itemFingerprint: item.itemFingerprint,
      mongoId: item.mongoId,
      preimageSha256: item.preimageSha256,
    })),
  });
  return {
    packet,
    enrichment,
    identityAudit,
    providerCapture,
    mongoCapture,
    captureDates: remediationCaptureDates(skipped),
    counts: Object.fromEntries([
      "CANCEL_AND_ARCHIVE", "QUARANTINE_AND_ARCHIVE", "RECONCILE_PROVIDER_TIME", "REPAIR_METADATA_IDENTITY",
    ].map((category) => [category, prepared.filter((item) => item.category === category).length])),
  };
}

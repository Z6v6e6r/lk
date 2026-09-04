#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { auditLegacyGameRevisionWriters } from "./audit_legacy_game_revision_writers.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  BASE_GAME_CREATE_FUNC_SHA256,
  patchVivaGameCreateTenantRevisionBase,
  SERVER_OWNED_GAME_TENANT_PRECONDITION,
} from "./lib/vivaGameCreateTenantRevisionContract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const RESULT_FN_DIR = path.join(SCRIPT_DIR, "nodered_result_nodes");
const PREREQUISITE_FN_DIR = path.join(SCRIPT_DIR, "nodered_legacy_command_prerequisite_nodes");
const REGISTRY_PATH = path.join(SCRIPT_DIR, "legacy_game_revision_writers.json");
const EXPECTED_SOURCE_SHA256 = "14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350";
const EXPECTED_NODE_COUNT = 4762;
const EXPECTED_ROUTE_COUNT = 215;
const TAB_ID = "4b91e2a2413688db";
export const PREREQUISITE_GAME_CREATE_FUNC_SHA256 = "2f4b72e351996321701d85275f50ae2f790a02aaef4fc430c84d810225dbd235";

const IDS = Object.freeze({
  patchRoute: "7ad34f13c4b25d60",
  patchAliasRoute: "4cb1e542db56b508",
  patchPrepare: "e0d7883bc1a9fa8c",
  patchArgs: "b2a10027fc45966c",
  patchMongo: "591234d213742276",
  patchResponse: "e17f8a411d4dfa91",
  patchDebug: "3b822085d5f18e97",
  patchAutojoin: "5fc5eaeab97f3f88",
  patchCasGuard: "lk_game_patch_cas_guard_20260801",
  patchCasQuery: "lk_game_patch_apply_cas_20260801",
  patchResponseGate: "lk_game_patch_response_gate_20260801",
  patchAutojoinGate: "lk_game_patch_autojoin_gate_20260801",
  patchAfterWrite: "lk_game_patch_after_write_20260801",
  patchCatch: "lk_game_patch_write_catch_20260801",
  create: "e656cff36a8cd210",
  createMongo: "5eaf4c087c0cc668",
  createResponse: "ae5ee70de15fe66e",
  createDebug: "60a3353902ae9973",
  createAutojoin: "9756d9125563753f",
  createAck: "lk_game_create_revision_ack_20260826",
  createCatch: "lk_game_create_revision_catch_20260826",
  cleanupPrepare: "9508f8e0ae8d282a",
  cleanupRouter: "bcc3dccf8d64f9bb",
  cleanupMongo: "11079a30bf3cc6ad",
  cleanupResponse: "e71d73fb91b0c3f0",
  cleanupDebug: "ba322f367a4d4fcd",
  cleanupAck: "lk_split_cleanup_revision_ack_20260826",
  cleanupCatch: "lk_split_cleanup_revision_catch_20260826",
  cleanupRecoveryMongo: "lk_split_cleanup_revision_recovery_write_20260826",
  cleanupRecoveryAck: "lk_split_cleanup_revision_recovery_ack_20260826",
  cleanupRecoveryCatch: "lk_split_cleanup_revision_recovery_catch_20260826",
  splitLeavePrepare: "016d6797a530ed0a",
  splitLeave: "lk_split_leave_game_update_build_20260801",
  rosterPrepare: "legacy_roster_bridge_prepare_20260816",
  rosterResponse: "legacy_roster_bridge_response_20260816",
  rosterAck: "legacy_roster_bridge_ack_20260816",
  paymentConfirmQuery: "legacy_payment_confirm_query_20260816",
  paymentConfirmCanonical: "legacy_payment_confirm_canonical_prepare_20260816",
  rosterProjection: "legacy_roster_bridge_build_20260816",
  resultRevisionQuery: "eb7060667c2da065",
  resultSubmitRevisionProjection: "result_submit_after_write_003",
  resultSubmitBuild: "4ba07d3d50014066",
  resultSubmitMongo: "ec61dea76846384b",
  resultSubmitResponse: "54b39ec3440143e5",
  resultSubmitEvent: "b10dc78b4d689ac3",
  resultSubmitHttpResponse: "da59c50f0f6e6908",
  resultSubmitDebug: "b558532591736d68",
  resultSubmitAck: "lk_result_submit_game_revision_ack_20260826",
  resultSubmitCatch: "lk_result_submit_game_revision_catch_20260826",
  resultSubmitIdempotencyRead: "lk_result_submit_idempotency_read_20260826",
  resultSubmitIdempotencyAck: "lk_result_submit_idempotency_ack_20260826",
  resultConfirmRoute: "cb002a5dcea9ce51",
  resultConfirmApply: "c67e08684d1e4fe9",
  resultConfirmReplay: "lk_result_confirm_replay_outbox_20260826",
  resultConfirmMongo: "42e62f98e51bf04a",
  resultConfirmRatings: "882a70c94963f87d",
  resultConfirmHttpResponse: "2383e98279c83f71",
  resultConfirmDebug: "dd78345026896107",
  resultConfirmEvent: "f5c21b6a457eb284",
  resultConfirmSync: "fde7ae86376b6289",
  resultConfirmAck: "lk_result_confirm_game_revision_ack_20260826",
  resultConfirmCatch: "lk_result_confirm_game_revision_catch_20260826",
  storeConfig: "lk_legacy_command_store_config_20260826",
  resultClaimRating: "lk_result_side_effect_claim_rating_20260826",
  resultClaimEvent: "lk_result_side_effect_claim_event_20260826",
  resultClaimViva: "lk_result_side_effect_claim_viva_20260826",
  resultCompleteRating: "lk_result_side_effect_complete_rating_20260826",
  resultCompleteEvent: "lk_result_side_effect_complete_event_20260826",
  resultCompleteViva: "lk_result_side_effect_complete_viva_20260826",
  resultRatingAck: "lk_result_side_effect_rating_ack_20260826",
  resultEventAck: "lk_result_side_effect_event_ack_20260826",
  resultVivaOutboxAck: "lk_result_side_effect_viva_outbox_ack_20260826",
  resultVivaIdentityRead: "lk_result_side_effect_viva_identity_read_20260826",
  resultVivaStatusAck: "lk_result_side_effect_viva_status_ack_20260826",
  resultVivaAfterCompletion: "lk_result_side_effect_viva_after_completion_20260826",
  resultRatingCatch: "lk_result_side_effect_rating_catch_20260826",
  resultEventCatch: "lk_result_side_effect_event_catch_20260826",
  resultVivaOutboxCatch: "lk_result_side_effect_viva_outbox_catch_20260826",
  resultVivaStatusCatch: "lk_result_side_effect_viva_status_catch_20260826",
  resultConfirmPrepare: "7f849685670dfbc1",
  resultSubmitPrepare: "d9d59722b0a76189",
  resultExpirePrepare: "22f949502de37430",
  resultConfirmBuildQuery: "0a24ae59bba45f7f",
  resultConfirmPrepareRatings: "66ced3f3c4046229",
  resultSubmitBuildQuery: "6c34988ca02fd63b",
  cleanupQuery: "dcd649158bd8df8e",
  resultRatingCompatibilityMongo: "result_rating_compatibility_write_001",
  resultRatingLedgerMongo: "result_rating_ledger_append_001",
  resultRatingStateMongo: "127cf4d595cc30bc",
  resultRatingProjection: "result_rating_ledger_projection_001",
  resultRatingLedgerBuild: "cbc3af09f9e929f4",
  resultRatingStateBuild: "1dd46edba0d97ab8",
  resultRatingCompatibilityBuild: "result_rating_compatibility_prepare_001",
  resultVivaOutboxPrepare: "6c5512b06d079e30",
  resultVivaOutboxMongo: "1b85784bf9aa5196",
  resultVivaRequestPrepare: "0dafa71f5e7361d2",
  resultVivaHandleResponse: "fda494e359188dd4",
  resultVivaStatusMongo: "b669e73f4c86cd56",
  resultVivaJoin: "843ae21e15d47cbc",
  resultVivaSummary: "e0bd5113ec685162",
  resultVivaFinalize: "d0f0fd9ca2dc9f5d",
  resultVivaSummaryRebuild: "69204d176d87b5eb",
  resultVivaRetryPrepare: "b8816d9c1cde37da",
});

const ACTIVE_FUNCTION_HASHES = Object.freeze({
  [IDS.create]: "08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f",
  [IDS.patchPrepare]: "4fb7d6ca9961e854cefb22f0752f9c1f921e1b6cbacfea3ce16e8b8681538931",
  [IDS.cleanupPrepare]: "988bacd186c89d3901a60ab01433c4a928aa860e452ad14253bb0515b614acd6",
  [IDS.cleanupRouter]: "676a2caff25cb948fb791e69c98dbdb58431f861957ef21fb9f481fc13bb3186",
  [IDS.splitLeavePrepare]: "e2653faa2532f546dca497ef683c43b3bf26d3b151ae9b4ab24fb49898bf69d7",
  [IDS.splitLeave]: "fa40192d2fd5373c06c0a7c47350994ab55235e39279f0f41347856b20c7d040",
  [IDS.rosterPrepare]: "65010c20737ac40985910e81fd17f3e19a8c7280a3a6ed13e98a6a93dd91c3a0",
  [IDS.rosterResponse]: "bc18bbb2240b5f7964b366db1bec51b32f2bae41a9e72925eb2c5e1f6b5f02d2",
  [IDS.rosterAck]: "3ab7a8741336a9879803b727722fa65d8522c6e1aa941b18c9476df7041a19dd",
  [IDS.paymentConfirmQuery]: "bbcaf2a5c49e568b56c18388f6f75a7badfaf3b4cbaa19bc9f8add7039663525",
  [IDS.paymentConfirmCanonical]: "f022be0ba44ab4dd90a739a739d8da91996dcb21fb0c42dcbf36ba01ac909647",
  [IDS.rosterProjection]: "a55ba88590866f93e7ebc7b432a00435acf022f463a1c8b6bd007f374e0e13b0",
  [IDS.resultRevisionQuery]: "40c7d81d277d3fee543916266a80ae546f3a5dc4d17f457b12c55c275464207e",
  [IDS.resultSubmitRevisionProjection]: "2dfaf311268660803543539310e254b8f5ab5ce86d5e0ce69bdf4c90d1435f3f",
  [IDS.resultSubmitBuild]: "1c69e50f19ca1d82b337218ec8ac70bfd4e56db731b613388e0f92181cce3562",
  [IDS.resultConfirmRoute]: "a4b5b257c6e07337eed70822f2d3d21bf087a85728d8b75a97fbc7df50af901e",
  [IDS.resultConfirmApply]: "8da7c80e74b6751586bdd343199e0622090546cdc95539aee96d04840a97ddc8",
  [IDS.resultConfirmPrepare]: "b05390f08841392d6a3eb239d994034d944621687214f978882cfb3fcac15dcb",
  [IDS.resultSubmitPrepare]: "8ca953c6c716b1b2aae4e8de66887425b859a5d1bd7e8aac9f775748f8e5767e",
  [IDS.resultExpirePrepare]: "38308c2695076940cd9b4036a18b379e81932d8d1f88e022d0811878a52240c2",
  [IDS.cleanupQuery]: "5a9086fc840885d90c49469aed6e867e6ad5aaa7abc81a188e8b86e927298d1e",
  [IDS.resultVivaOutboxPrepare]: "b9046b30e65403912a61970ba925afa6e4ccd1290a9a7b8bd433bcb6efc03c4d",
  [IDS.resultVivaHandleResponse]: "ebd65501dbcea3616da846d8744ab323e806909b8c6203cce2fd01efa52993da",
  [IDS.resultRatingProjection]: "b4badacb1fe6fbebf9c9bb17ed5cc820421cace055cf0bdab1912c9eebea0d5a",
  [IDS.resultConfirmBuildQuery]: "4b6947c4fe1fd9fc1cb000661ed15d017555cfeb41e86322d158a405d673b2a5",
  [IDS.resultSubmitBuildQuery]: "6695b911ebeb42174494929a14aa37af2d0a271c485c9663ec639aa999e2ee61",
  [IDS.resultConfirmPrepareRatings]: "07d2e612e015ee8951d0bde15641aca2eaeeb9b975c3aaafa4f5254423ae4172",
  [IDS.resultRatingLedgerBuild]: "9c28bf0059071011c2cdbdcafa87e4c4b3ad87581fe1cef1b1831018d8fb0147",
  [IDS.resultRatingStateBuild]: "d2c9f4670c69bf5235527327be0a18b15fb0f903afb4ee2dffcf6adcc95fc41a",
  [IDS.resultRatingCompatibilityBuild]: "62d720d78a4594557d444d23d465fbad2cdac5bc07ef3f90141a717c6cb2b266",
  [IDS.resultVivaFinalize]: "163bea95a4ccee198eaa641d33098ae3403a0df4c7417d2be3d964d58acf7a73",
  [IDS.resultVivaSummary]: "08fd43e98484bfa7ffff81ac8cff79d109a0447476d47ed60a166d11b604eda0",
  [IDS.resultVivaSummaryRebuild]: "6ba4efc464124142a8d38cb0902f5eed1e97b5e70c820014f6a8d0aa3406f7a7",
  [IDS.resultVivaRetryPrepare]: "b0e17bd62e723f6dd105d999cf0352d902f6cb327e652c875450742f7cb61919",
});

const SOURCE_BY_NODE = Object.freeze({
  [IDS.patchCasGuard]: "fn_patch_revision_guard.js",
  [IDS.patchCasQuery]: "fn_patch_revision_query.js",
  [IDS.patchResponseGate]: "fn_patch_response_gate.js",
  [IDS.patchAutojoinGate]: "fn_patch_autojoin_gate.js",
  [IDS.patchAfterWrite]: "fn_patch_after_write.js",
  [IDS.resultRevisionQuery]: "fn_result_revision_query.js",
  [IDS.resultSubmitRevisionProjection]: "fn_result_submit_revision_projection.js",
  [IDS.createAck]: "fn_create_revision_ack.js",
  [IDS.resultSubmitAck]: "fn_result_submit_revision_ack.js",
  [IDS.resultSubmitIdempotencyAck]: "fn_result_submit_idempotency_readback_ack.js",
  [IDS.resultConfirmRoute]: "fn_result_confirm_revision_route.js",
  [IDS.resultConfirmAck]: "fn_result_confirm_revision_ack.js",
  [IDS.cleanupAck]: "fn_cleanup_revision_ack.js",
  [IDS.cleanupRecoveryAck]: "fn_cleanup_revision_recovery_ack.js",
  [IDS.resultConfirmReplay]: "fn_result_side_effect_dispatch.js",
  [IDS.resultConfirmPrepare]: "fn_result_confirm_prepare.js",
  [IDS.resultSubmitPrepare]: "fn_result_submit_prepare.js",
  [IDS.resultExpirePrepare]: "fn_result_expire_prepare_game_query.js",
  [IDS.cleanupQuery]: "fn_split_cleanup_query.js",
  [IDS.resultVivaOutboxPrepare]: "fn_result_viva_sync_outbox_prepare.js",
  [IDS.resultVivaHandleResponse]: "fn_result_viva_sync_handle_response.js",
  [IDS.resultRatingProjection]: "fn_result_rating_ledger_projection_msg.js",
  [IDS.resultConfirmBuildQuery]: "fn_result_confirm_build_results_query.js",
  [IDS.resultSubmitBuildQuery]: "fn_result_submit_build_query.js",
  [IDS.resultConfirmPrepareRatings]: "fn_result_confirm_prepare_ratings_query.js",
  [IDS.resultRatingLedgerBuild]: "fn_result_rating_ledger_event_msg.js",
  [IDS.resultRatingStateBuild]: "fn_result_rating_ledger_state_msg.js",
  [IDS.resultRatingCompatibilityBuild]: "fn_result_rating_compatibility_msg.js",
  [IDS.resultRatingAck]: "fn_result_rating_sink_ack.js",
  [IDS.resultEventAck]: "fn_result_event_sink_ack.js",
  [IDS.resultVivaOutboxAck]: "fn_result_viva_outbox_ack.js",
  [IDS.resultVivaStatusAck]: "fn_result_viva_status_ack.js",
  [IDS.resultVivaAfterCompletion]: "fn_result_viva_after_completion.js",
  [IDS.resultVivaFinalize]: "fn_result_viva_sync_finalize_batch.js",
  [IDS.resultVivaSummary]: "fn_result_viva_sync_prepare_summary_query.js",
  [IDS.resultVivaSummaryRebuild]: "fn_result_viva_sync_rebuild_summary.js",
  [IDS.resultVivaRetryPrepare]: "fn_result_viva_sync_retry_prepare.js",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const readFn = (fileName) => {
  const directory = [PREREQUISITE_FN_DIR, FN_DIR, RESULT_FN_DIR]
    .find((candidate) => fs.existsSync(path.join(candidate, fileName)));
  if (!directory) fail(`Missing source function ${fileName}`);
  return fs.readFileSync(path.join(directory, fileName), "utf8");
};
const fail = (message) => { throw new Error(message); };
const exactNode = (flow, id, type) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1 || matches[0].type !== type) fail(`Expected exact ${type} node ${id}`);
  return matches[0];
};
const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((key) => !isDeepStrictEqual(before[key], after[key]))
  .sort();

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    fail(`Expected one exact ${label} preimage`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

export function patchLegacyGameCreatePrerequisiteCasAck(source) {
  if (sha256(source) !== BASE_GAME_CREATE_FUNC_SHA256) fail("Game create base preimage mismatch");
  let next = replaceOnce(
    source,
    `${SERVER_OWNED_GAME_TENANT_PRECONDITION}\n\nconst record = {`,
    `${SERVER_OWNED_GAME_TENANT_PRECONDITION}\nconst expectedRevisionText = String(body.expectedRevision ?? "").trim();\nconst expectedRevision = /^\\d+$/.test(expectedRevisionText) ? Number(expectedRevisionText) : null;\nif (expectedRevisionText && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {\n  const errMsg = Object.assign({}, msg, {\n    statusCode: 400,\n    headers: { "Content-Type": "application/json; charset=utf-8" },\n    payload: { error: "expectedRevision has invalid format", code: "LEGACY_GAME_REVISION_INVALID" },\n  });\n  return [null, errMsg, errMsg, null];\n}\n\nconst record = {`,
    "create revision precondition",
  );
  next = replaceOnce(
    next,
    "const queryFilter = {\n  tenantKey,\n  ...(paymentRef ? {\n    $or: [\n      { \"metadata.paymentRef\": paymentRef },\n      { \"payment.paymentRef\": paymentRef },\n    ],\n  } : { dedupeKey }),\n};",
    "const queryFilter = {\n  tenantKey,\n  id: gameId,\n  revision: expectedRevision === null ? { $exists: false } : expectedRevision,\n  ...(paymentRef ? {\n    $or: [\n      { \"metadata.paymentRef\": paymentRef },\n      { \"payment.paymentRef\": paymentRef },\n    ],\n  } : { dedupeKey }),\n};",
    "create identity revision filter",
  );
  next = replaceOnce(
    next,
    "    record,\n  ),",
    "    record,\n    { revision: expectedRevision === null ? 1 : expectedRevision + 1 },\n  ),",
    "create response revision",
  );
  const patched = replaceOnce(
    next,
    "return [dbMsg, responseMsg, debugMsg, autojoinMsg];",
    "dbMsg._createRevisionDebug = debugMsg.payload;\nreturn [dbMsg, null, null, null];",
    "create acknowledgement gate",
  );
  if (sha256(patched) !== PREREQUISITE_GAME_CREATE_FUNC_SHA256) fail("Game create prerequisite postimage mismatch");
  return patched;
}

export function upgradeLegacyGameWriterFunction(nodeId, source) {
  if (nodeId === IDS.create) {
    if (source.includes("GAME_PAYMENT_CONFIRM_GUARD_START")) {
      let next = replaceOnce(
        source,
        "const record = {\n  id: gameId,\n  tenantKey: toStr(body.tenantKey) || null,",
        `${SERVER_OWNED_GAME_TENANT_PRECONDITION}\n\nconst record = {\n  id: gameId,\n  tenantKey,`,
        "combined create tenant precondition",
      );
      next = replaceOnce(
        next,
        `const queryFilter = mode === "confirm"
  ? {
      $and: [
        paymentRefFilter,
        { archived: { $ne: true } },
        { status: "PAYMENT_PENDING" },
        expectedRevision !== null
          ? { revision: expectedRevision }
          : { updatedAt: expectedUpdatedAt },
      ],
    }
  : paymentRefFilter;`,
        `const queryFilter = {
  tenantKey,
  id: gameId,
  revision: expectedRevision === null ? { $exists: false } : expectedRevision,
  ...(mode === "confirm" ? {
    archived: { $ne: true },
    status: "PAYMENT_PENDING",
  } : {}),
  ...paymentRefFilter,
};`,
        "combined create identity revision filter",
      );
      next = replaceOnce(
        next,
        "    $push: {\n      \"audit.events\": {\n        $each: [auditEvent],\n        $slice: -AUDIT_MAX_EVENTS,\n      },\n    },",
        "    $push: {\n      \"audit.events\": {\n        $each: [auditEvent],\n        $slice: -AUDIT_MAX_EVENTS,\n      },\n    },\n    $inc: { revision: 1 },",
        "combined create revision increment",
      );
      next = replaceOnce(
        next,
        "    record,\n  ),",
        "    record,\n    { revision: expectedRevision === null ? 1 : expectedRevision + 1 },\n  ),",
        "combined create response revision",
      );
      next = replaceOnce(
        next,
        `return [
  dbMsg,
  mode === "confirm" ? null : responseMsg,
  debugMsg,
  mode === "confirm" ? null : autojoinMsg,
];`,
        "dbMsg._createRevisionDebug = debugMsg.payload;\nreturn [dbMsg, null, null, null];",
        "combined create acknowledgement gate",
      );
      return next;
    }
    return patchLegacyGameCreatePrerequisiteCasAck(patchVivaGameCreateTenantRevisionBase(source));
  }
  if (nodeId === IDS.cleanupPrepare) {
    let next = replaceOnce(
      source,
      "      mode: \"PARTICIPANT_TIMEOUT\",\n      gameId,\n      reason:",
      "      mode: \"PARTICIPANT_TIMEOUT\",\n      gameId,\n      tenantKey: game.tenantKey,\n      revision: game.revision,\n      reason:",
      "participant-timeout revision",
    );
    next = replaceOnce(
      next,
      "    mode: \"GAME_CLEANUP\",\n    gameId,\n    reason,",
      "    mode: \"GAME_CLEANUP\",\n    gameId,\n    tenantKey: game.tenantKey,\n    revision: game.revision,\n    reason,",
      "game-cleanup revision",
    );
    return next;
  }
  if (nodeId === IDS.cleanupRouter) {
    if (source.includes("_splitCleanupWriteAck")) {
      let next = replaceOnce(
        source,
        `    query: {
      id: ctx.gameId,
      archived: { $ne: true },
      ...(ctx.expectedRevision !== null
        ? { revision: ctx.expectedRevision }
        : { updatedAt: ctx.expectedUpdatedAt }),
      ...(toStr(ctx.statusBefore) ? { status: toStr(ctx.statusBefore) } : {}),
    },`,
        `    query: {
      tenantKey: ctx.sourceTenantKey,
      id: ctx.gameId,
      archived: { $ne: true },
      revision: ctx.sourceRevision,
      ...(toStr(ctx.statusBefore) ? { status: toStr(ctx.statusBefore) } : {}),
    },`,
        "combined cleanup CAS query",
      );
      next = replaceOnce(
        next,
        "      $push: {\n        \"audit.events\": {\n          $each: [auditEvent],\n          $slice: -AUDIT_MAX_EVENTS,\n        },\n      },\n    },",
        "      $push: {\n        \"audit.events\": {\n          $each: [auditEvent],\n          $slice: -AUDIT_MAX_EVENTS,\n        },\n      },\n      $inc: { revision: 1 },\n    },",
        "combined cleanup revision increment",
      );
      next = replaceOnce(
        next,
        "    mode: toStr(payload?.mode) || \"GAME_CLEANUP\",\n    gameId,\n    tenantKey: toStr(payload?.tenantKey),\n    reason:",
        "    mode: toStr(payload?.mode) || \"GAME_CLEANUP\",\n    gameId,\n    tenantKey: toStr(payload?.tenantKey),\n    sourceTenantKey: toStr(payload?.tenantKey),\n    sourceRevision: Number.isSafeInteger(payload?.revision) ? payload.revision : null,\n    reason:",
        "combined cleanup revision context",
      );
      next = replaceOnce(
        next,
        "  if (initialCtx.mode === \"PARTICIPANT_TIMEOUT\") {",
        "  if (!initialCtx.sourceTenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(initialCtx.sourceTenantKey)) {\n    initialCtx.blockLocalMutation = true;\n    initialCtx.blockReason = \"legacy_game_tenant_required\";\n    appendTrace(initialCtx, { step: \"blocked_missing_game_tenant\", gameId });\n    return finalizeTask(initialCtx);\n  }\n  if (!Number.isSafeInteger(initialCtx.sourceRevision) || initialCtx.sourceRevision < 1) {\n    initialCtx.blockLocalMutation = true;\n    initialCtx.blockReason = \"legacy_game_revision_required\";\n    appendTrace(initialCtx, { step: \"blocked_missing_game_revision\", gameId });\n    return finalizeTask(initialCtx);\n  }\n  if (initialCtx.mode === \"PARTICIPANT_TIMEOUT\") {",
        "combined cleanup missing-revision gate",
      );
      return replaceOnce(
        next,
        "  return [null, dbMsg, null, null];",
        "  dbMsg._splitCleanupRevisionDeferred = {\n    tenantKey: ctx.sourceTenantKey,\n    gameId: ctx.gameId,\n    sourceRevision: ctx.sourceRevision,\n    operationKey: ctx.operationKey,\n    summaryMsg,\n  };\n  return [null, dbMsg, null, null];",
        "combined cleanup acknowledgement gate",
      );
    }
    let next = replaceOnce(
      source,
      "      id: ctx.gameId,\n      archived: { $ne: true },\n    },",
      "      tenantKey: ctx.sourceTenantKey,\n      id: ctx.gameId,\n      archived: { $ne: true },\n      revision: ctx.sourceRevision,\n    },",
      "cleanup CAS query",
    );
    next = replaceOnce(
      next,
      "      $push: {\n        \"audit.events\": {\n          $each: [auditEvent],\n          $slice: -AUDIT_MAX_EVENTS,\n        },\n      },\n    },",
      "      $push: {\n        \"audit.events\": {\n          $each: [auditEvent],\n          $slice: -AUDIT_MAX_EVENTS,\n        },\n      },\n      $inc: { revision: 1 },\n    },",
      "cleanup revision increment",
    );
    next = replaceOnce(
      next,
      "    mode: toStr(payload?.mode) || \"GAME_CLEANUP\",\n    gameId,\n    reason:",
      "    mode: toStr(payload?.mode) || \"GAME_CLEANUP\",\n    gameId,\n    sourceTenantKey: toStr(payload?.tenantKey),\n    sourceRevision: Number.isSafeInteger(payload?.revision) ? payload.revision : null,\n    reason:",
      "cleanup revision context",
    );
    next = replaceOnce(
      next,
      "  if (initialCtx.mode === \"PARTICIPANT_TIMEOUT\") {",
      "  if (!initialCtx.sourceTenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(initialCtx.sourceTenantKey)) {\n    initialCtx.blockLocalMutation = true;\n    initialCtx.blockReason = \"legacy_game_tenant_required\";\n    appendTrace(initialCtx, { step: \"blocked_missing_game_tenant\", gameId });\n    return finalizeTask(initialCtx);\n  }\n  if (!Number.isSafeInteger(initialCtx.sourceRevision) || initialCtx.sourceRevision < 1) {\n    initialCtx.blockLocalMutation = true;\n    initialCtx.blockReason = \"legacy_game_revision_required\";\n    appendTrace(initialCtx, { step: \"blocked_missing_game_revision\", gameId });\n    return finalizeTask(initialCtx);\n  }\n  if (initialCtx.mode === \"PARTICIPANT_TIMEOUT\") {",
      "cleanup missing-revision gate",
    );
    return replaceOnce(
      next,
      "  return [null, dbMsg, summaryMsg, summaryMsg];",
      "  dbMsg._splitCleanupRevisionDeferred = {\n    tenantKey: ctx.sourceTenantKey,\n    gameId: ctx.gameId,\n    sourceRevision: ctx.sourceRevision,\n    operationKey: ctx.operationKey,\n    summaryMsg,\n  };\n  return [null, dbMsg, null, null];",
      "cleanup acknowledgement gate",
    );
  }
  if (nodeId === IDS.splitLeavePrepare) {
    let next = replaceOnce(
      source,
      "const body = isObj(msg.payload) ? msg.payload : {};",
      "const body = isObj(msg.payload) ? msg.payload : {};\nlet tenantKey = null;\ntry { tenantKey = toStr(env.get(\"PADLHUB_PLATFORM_TENANT_KEY\")); } catch { tenantKey = null; }\nif (!tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {\n  return respond(503, \"CONFLICT\", \"Tenant игры не настроен\");\n}",
      "split-leave tenant configuration",
    );
    next = replaceOnce(
      next,
      "msg._splitLeaveCtx = {\n  gameId,",
      "msg._splitLeaveCtx = {\n  gameId,\n  tenantKey,",
      "split-leave tenant context",
    );
    return replaceOnce(
      next,
      "msg.payload = { id: gameId, archived: { $ne: true } };",
      "msg.payload = { tenantKey, id: gameId, archived: { $ne: true } };",
      "split-leave tenant read",
    );
  }
  if (nodeId === IDS.splitLeave) {
    let next = replaceOnce(
      source,
      "const game = ctx.game;\nconst nowIso",
      "const game = ctx.game;\nif (!ctx.tenantKey || game.tenantKey !== ctx.tenantKey) {\n  msg.statusCode = 202;\n  msg.payload = { ok: true, state: \"RETRY_REQUIRED\", operationId: ctx.operationId, gameId: ctx.gameId, code: \"LEGACY_GAME_TENANT_CONFLICT\", message: \"LK game tenant mismatch\" };\n  return [null, null, msg];\n}\nif (!Number.isSafeInteger(game.revision) || game.revision < 1) {\n  msg.statusCode = 202;\n  msg.payload = { ok: true, state: \"RETRY_REQUIRED\", operationId: ctx.operationId, gameId: ctx.gameId, code: \"LEGACY_GAME_REVISION_REQUIRED\", message: \"LK game revision migration is required before roster mutation\" };\n  return [null, null, msg];\n}\nconst nowIso",
      "split-leave revision gate",
    );
    next = replaceOnce(
      next,
      "const query = { id: ctx.gameId, archived: { $ne: true } };\nif (game.updatedAt !== undefined) query.updatedAt = game.updatedAt;",
      "const query = { tenantKey: ctx.tenantKey, id: ctx.gameId, archived: { $ne: true }, revision: game.revision };",
      "split-leave CAS query",
    );
    next = replaceOnce(
      next,
      "  $unset: {\n    resultRosterSnapshot: \"\",\n  },\n};",
      "  $unset: {\n    resultRosterSnapshot: \"\",\n  },\n  $inc: { revision: 1 },\n};",
      "split-leave revision increment",
    );
    return next;
  }
  if (nodeId === IDS.rosterPrepare) {
    return replaceOnce(
      source,
      "msg._legacyRosterBridge = { gameId, idempotencyKey, command, retryCount: 0 };",
      "msg._legacyRosterBridge = { tenantKey, gameId, idempotencyKey, command, retryCount: 0 };",
      "canonical roster tenant context",
    );
  }
  if (nodeId === IDS.rosterResponse) {
    return replaceOnce(
      source,
      "msg.payload = { id: legacyGameId, archived: { $ne: true } };",
      "msg.payload = { tenantKey: ctx.tenantKey, id: legacyGameId, archived: { $ne: true } };",
      "canonical roster tenant read",
    );
  }
  if (nodeId === IDS.rosterAck) {
    let next = replaceOnce(
      source,
      "msg.payload = { id: ctx.gameId, archived: { $ne: true } };",
      "msg.payload = { tenantKey: ctx.tenantKey, id: ctx.gameId, archived: { $ne: true } };",
      "canonical roster retry tenant read",
    );
    return replaceOnce(
      next,
      "payload: { id: ctx.gameId, archived: { $ne: true } },",
      "payload: { tenantKey: ctx.tenantKey, id: ctx.gameId, archived: { $ne: true } },",
      "canonical roster autojoin tenant read",
    );
  }
  if (nodeId === IDS.paymentConfirmQuery) {
    let next = replaceOnce(
      source,
      "const gameId = toStr(msg.req?.params?.gameId);",
      "const tenantKey = envValue(\"PADLHUB_PLATFORM_TENANT_KEY\");\nif (!tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {\n  return respond(503, \"LEGACY_GAME_TENANT_CONFIG_INVALID\", \"Tenant игры не настроен\");\n}\nconst gameId = toStr(msg.req?.params?.gameId);",
      "payment confirmation tenant configuration",
    );
    next = replaceOnce(
      next,
      "msg._legacyPaymentConfirm = {\n  gameId,",
      "msg._legacyPaymentConfirm = {\n  tenantKey,\n  gameId,",
      "payment confirmation tenant context",
    );
    return replaceOnce(
      next,
      "msg.payload = { id: gameId, archived: { $ne: true } };",
      "msg.payload = { tenantKey, id: gameId, archived: { $ne: true } };",
      "payment confirmation tenant read",
    );
  }
  if (nodeId === IDS.paymentConfirmCanonical) {
    return replaceOnce(
      source,
      "msg._legacyRosterBridge = {\n  gameId: ctx.gameId,",
      "msg._legacyRosterBridge = {\n  tenantKey,\n  gameId: ctx.gameId,",
      "payment canonical roster tenant context",
    );
  }
  if (nodeId === IDS.rosterProjection) {
    let next = replaceOnce(
      source,
      "const game = asArray(msg.payload).find((item) => isObj(item) && toStr(item.id) === ctx.gameId);\nif (!game) return fail(409, \"LEGACY_GAME_NOT_FOUND\", \"Игра не найдена в legacy-проекции\");",
      "const game = asArray(msg.payload).find((item) => isObj(item) && toStr(item.id) === ctx.gameId && toStr(item.tenantKey) === ctx.tenantKey);\nif (!game) return fail(409, \"LEGACY_GAME_NOT_FOUND\", \"Игра не найдена в legacy-проекции\");\nif (!Number.isSafeInteger(game.revision) || game.revision < 1) return fail(409, \"LEGACY_GAME_REVISION_REQUIRED\", \"Игра требует миграции revision до изменения состава\");",
      "projection revision gate",
    );
    next = replaceOnce(
      next,
      "const query = { id: ctx.gameId, archived: { $ne: true } };",
      "const query = { tenantKey: ctx.tenantKey, id: ctx.gameId, archived: { $ne: true } };",
      "projection tenant CAS query",
    );
    next = replaceOnce(
      next,
      "if (Object.prototype.hasOwnProperty.call(game, \"updatedAt\")) query.updatedAt = game.updatedAt;\nif (Number.isInteger(game.revision)) query.revision = game.revision;",
      "query.revision = game.revision;",
      "projection CAS query",
    );
    next = replaceOnce(
      next,
      "nextRevision: Number.isInteger(game.revision) ? game.revision + 1 : null,",
      "nextRevision: game.revision + 1,",
      "projection next revision",
    );
    next = replaceOnce(
      next,
      "...(Number.isInteger(game.revision) ? { $inc: { revision: 1 } } : {}),",
      "$inc: { revision: 1 },",
      "projection revision increment",
    );
    return next;
  }
  if (nodeId === IDS.resultSubmitBuild) {
    return readFn("fn_result_submit_build_insert.js");
  }
  if (nodeId === IDS.resultConfirmApply) {
    return readFn("fn_result_confirm_apply.js");
  }
  fail(`No revision upgrade registered for ${nodeId}`);
}

function functionNode(template, id, name, source, outputs, wires, x, y) {
  return {
    ...structuredClone(template),
    id,
    name,
    func: source,
    outputs,
    wires,
    x,
    y,
  };
}

function commandOperationNode(id, name, action, wires, x, y) {
  return {
    id,
    type: "padlhub-legacy-game-command-operation",
    z: TAB_ID,
    name,
    store: IDS.storeConfig,
    action,
    leaseMs: 30000,
    maxAttempts: 3,
    x,
    y,
    wires,
  };
}

export function buildLegacyGameCommandPrerequisiteCandidate(source) {
  if (!Array.isArray(source)) fail("Node-RED source must be an array");
  if (source.length !== EXPECTED_NODE_COUNT) fail("Live flow node count mismatch");
  if (source.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
    fail("Live flow HTTP route count mismatch");
  }
  const flow = structuredClone(source);
  const before = structuredClone(source);
  const tab = exactNode(flow, TAB_ID, "tab");
  if (tab.label !== "LK Games" || tab.disabled !== false) fail("LK Games tab contract mismatch");

  for (const [id, expectedHash] of Object.entries(ACTIVE_FUNCTION_HASHES)) {
    const node = exactNode(flow, id, "function");
    if (sha256(node.func || "") !== expectedHash) fail(`Active function preimage drift for ${id}`);
  }

  const patchRoute = exactNode(flow, IDS.patchRoute, "http in");
  const patchAliasRoute = exactNode(flow, IDS.patchAliasRoute, "http in");
  const patchPrepare = exactNode(flow, IDS.patchPrepare, "function");
  const patchArgs = exactNode(flow, IDS.patchArgs, "function");
  const patchMongo = exactNode(flow, IDS.patchMongo, "mongodb4");
  exactNode(flow, IDS.patchResponse, "http response");
  exactNode(flow, IDS.patchDebug, "debug");
  exactNode(flow, IDS.patchAutojoin, "mongodb4");
  const createMongo = exactNode(flow, IDS.createMongo, "mongodb4");
  exactNode(flow, IDS.createResponse, "http response");
  exactNode(flow, IDS.createDebug, "debug");
  exactNode(flow, IDS.createAutojoin, "function");
  const resultSubmitMongo = exactNode(flow, IDS.resultSubmitMongo, "mongodb4");
  const resultSubmitRevisionProjection = exactNode(flow, IDS.resultSubmitRevisionProjection, "function");
  const resultConfirmMongo = exactNode(flow, IDS.resultConfirmMongo, "mongodb4");
  const resultConfirmApply = exactNode(flow, IDS.resultConfirmApply, "function");
  const resultRatingCompatibilityMongo = exactNode(flow, IDS.resultRatingCompatibilityMongo, "mongodb4");
  const resultRatingProjection = exactNode(flow, IDS.resultRatingProjection, "function");
  const resultConfirmEvent = exactNode(flow, IDS.resultConfirmEvent, "mongodb4");
  const resultVivaSplit = exactNode(flow, IDS.resultConfirmSync, "split");
  const resultVivaOutboxMongo = exactNode(flow, IDS.resultVivaOutboxMongo, "mongodb4");
  const resultVivaStatusMongo = exactNode(flow, IDS.resultVivaStatusMongo, "mongodb4");
  const cleanupMongo = exactNode(flow, IDS.cleanupMongo, "mongodb4");
  exactNode(flow, IDS.cleanupResponse, "join");
  exactNode(flow, IDS.cleanupDebug, "debug");
  const template = exactNode(flow, IDS.splitLeave, "function");

  // The active flow preimage remains pinned above. The combined candidate must use
  // the task-owned fail-closed PATCH source before the revision/CAS gates are wired.
  patchPrepare.func = readFn("fn_patch.js");

  const expectedWires = new Map([
    [IDS.patchRoute, [[IDS.patchPrepare]]],
    [IDS.patchAliasRoute, [[IDS.patchPrepare]]],
    [IDS.patchPrepare, [[IDS.patchArgs], [IDS.patchResponse], [IDS.patchDebug], [IDS.patchAutojoin]]],
    [IDS.patchArgs, [[IDS.patchMongo]]],
    [IDS.patchMongo, [[]]],
    [IDS.createMongo, [[]]],
    [IDS.resultSubmitMongo, [[]]],
    [IDS.resultConfirmMongo, [[]]],
    [IDS.cleanupMongo, [[]]],
    [IDS.resultRatingCompatibilityMongo, [[IDS.resultRatingProjection]]],
    [IDS.resultRatingProjection, [[IDS.resultVivaOutboxPrepare, IDS.resultVivaRequestPrepare]]],
    [IDS.resultConfirmEvent, [[]]],
    [IDS.resultConfirmSync, [[IDS.resultVivaOutboxPrepare, IDS.resultVivaRequestPrepare]]],
    [IDS.resultVivaOutboxMongo, [[]]],
    [IDS.resultVivaStatusMongo, [[]]],
    [IDS.resultConfirmApply, [
      ["2aaec6825955e3f2"],
      [],
      [],
      [IDS.resultConfirmHttpResponse],
      [IDS.resultConfirmDebug],
      [],
    ]],
  ]);
  for (const [id, wires] of expectedWires) {
    if (!isDeepStrictEqual(exactNode(flow, id, flow.find((node) => node.id === id).type).wires, wires)) {
      fail(`PATCH wire preimage drift for ${id}`);
    }
  }
  for (const id of [
    IDS.patchCasGuard,
    IDS.patchCasQuery,
    IDS.patchResponseGate,
    IDS.patchAutojoinGate,
    IDS.patchAfterWrite,
    IDS.patchCatch,
    IDS.createAck,
    IDS.createCatch,
    IDS.resultSubmitAck,
    IDS.resultSubmitCatch,
    IDS.resultSubmitIdempotencyRead,
    IDS.resultSubmitIdempotencyAck,
    IDS.resultConfirmAck,
    IDS.resultConfirmCatch,
    IDS.cleanupAck,
    IDS.cleanupCatch,
    IDS.cleanupRecoveryMongo,
    IDS.cleanupRecoveryAck,
    IDS.cleanupRecoveryCatch,
    IDS.resultConfirmReplay,
    IDS.storeConfig,
    IDS.resultClaimRating,
    IDS.resultClaimEvent,
    IDS.resultClaimViva,
    IDS.resultCompleteRating,
    IDS.resultCompleteEvent,
    IDS.resultCompleteViva,
    IDS.resultRatingAck,
    IDS.resultEventAck,
    IDS.resultVivaOutboxAck,
    IDS.resultVivaIdentityRead,
    IDS.resultVivaStatusAck,
    IDS.resultVivaAfterCompletion,
    IDS.resultRatingCatch,
    IDS.resultEventCatch,
    IDS.resultVivaOutboxCatch,
    IDS.resultVivaStatusCatch,
  ]) {
    if (flow.some((node) => node.id === id)) fail(`Prerequisite node already exists: ${id}`);
  }

  for (const id of [
    IDS.create,
    IDS.cleanupPrepare,
    IDS.cleanupRouter,
    IDS.splitLeave,
    IDS.rosterProjection,
    IDS.splitLeavePrepare,
    IDS.rosterPrepare,
    IDS.rosterResponse,
    IDS.rosterAck,
    IDS.paymentConfirmQuery,
    IDS.paymentConfirmCanonical,
    IDS.resultSubmitBuild,
    IDS.resultConfirmApply,
  ]) {
    const node = exactNode(flow, id, "function");
    node.func = upgradeLegacyGameWriterFunction(id, node.func);
  }
  for (const id of [
    IDS.resultRevisionQuery,
    IDS.resultSubmitRevisionProjection,
    IDS.resultConfirmRoute,
    IDS.resultConfirmPrepare,
    IDS.resultSubmitPrepare,
    IDS.resultExpirePrepare,
    IDS.cleanupQuery,
    IDS.resultVivaOutboxPrepare,
    IDS.resultVivaHandleResponse,
    IDS.resultRatingProjection,
    IDS.resultConfirmBuildQuery,
    IDS.resultSubmitBuildQuery,
    IDS.resultConfirmPrepareRatings,
    IDS.resultRatingLedgerBuild,
    IDS.resultRatingStateBuild,
    IDS.resultRatingCompatibilityBuild,
    IDS.resultVivaFinalize,
    IDS.resultVivaSummary,
    IDS.resultVivaSummaryRebuild,
    IDS.resultVivaRetryPrepare,
  ]) {
    exactNode(flow, id, "function").func = readFn(SOURCE_BY_NODE[id]);
  }
  if (resultConfirmApply.outputs !== 8) {
    resultConfirmApply.outputs = 8;
    resultConfirmApply.wires = [...resultConfirmApply.wires, [IDS.resultConfirmReplay], [IDS.resultRevisionQuery]];
  }
  resultSubmitRevisionProjection.outputs = 6;
  resultSubmitRevisionProjection.wires = [
    [IDS.resultSubmitResponse],
    [IDS.resultSubmitMongo],
    [IDS.resultSubmitEvent],
    [IDS.resultSubmitHttpResponse],
    [IDS.resultSubmitDebug],
    [IDS.resultSubmitIdempotencyRead],
  ];
  patchRoute.wires = [[IDS.patchCasGuard]];
  patchAliasRoute.wires = [[IDS.patchCasGuard]];
  patchPrepare.wires = [[IDS.patchArgs], [IDS.patchResponseGate], [IDS.patchDebug], [IDS.patchAutojoinGate]];
  patchArgs.wires = [[IDS.patchCasQuery]];
  patchMongo.wires = [[IDS.patchAfterWrite]];
  createMongo.wires = [[IDS.createAck]];
  resultSubmitMongo.wires = [[IDS.resultSubmitAck]];
  resultConfirmMongo.wires = [[IDS.resultConfirmAck]];
  cleanupMongo.wires = [[IDS.cleanupAck]];
  resultRatingCompatibilityMongo.wires = [[IDS.resultRatingAck]];
  resultRatingProjection.wires = [[IDS.resultClaimViva]];
  resultConfirmEvent.wires = [[IDS.resultEventAck]];
  resultVivaSplit.wires = [[IDS.resultClaimViva]];
  resultVivaOutboxMongo.wires = [[IDS.resultVivaOutboxAck]];
  resultVivaStatusMongo.wires = [[IDS.resultVivaStatusAck]];

  flow.push(
    functionNode(template, IDS.patchCasGuard, "Require mandatory game revision", readFn(SOURCE_BY_NODE[IDS.patchCasGuard]), 3, [
      [IDS.patchPrepare], [IDS.patchResponse], [IDS.patchDebug],
    ], 520, 3120),
    functionNode(template, IDS.patchResponseGate, "Gate pre-CAS PATCH response", readFn(SOURCE_BY_NODE[IDS.patchResponseGate]), 1, [[IDS.patchResponse]], 1000, 3160),
    functionNode(template, IDS.patchAutojoinGate, "Gate pre-CAS PATCH autojoin", readFn(SOURCE_BY_NODE[IDS.patchAutojoinGate]), 1, [[IDS.patchAutojoin]], 1000, 3200),
    functionNode(template, IDS.patchCasQuery, "Bind mandatory game revision CAS", readFn(SOURCE_BY_NODE[IDS.patchCasQuery]), 1, [[IDS.patchMongo]], 1240, 3120),
    functionNode(template, IDS.patchAfterWrite, "Acknowledge game revision CAS", readFn(SOURCE_BY_NODE[IDS.patchAfterWrite]), 3, [
      [IDS.patchResponse], [IDS.patchDebug], [IDS.patchAutojoin],
    ], 1480, 3120),
    {
      id: IDS.patchCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch game revision CAS write errors",
      scope: [IDS.patchMongo],
      uncaught: false,
      x: 1240,
      y: 3240,
      wires: [[IDS.patchAfterWrite]],
    },
    functionNode(template, IDS.createAck, "Acknowledge game identity revision write", readFn(SOURCE_BY_NODE[IDS.createAck]), 3, [
      [IDS.createResponse], [IDS.createDebug], [IDS.createAutojoin],
    ], 940, 2760),
    {
      id: IDS.createCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch game identity revision write errors",
      scope: [IDS.createMongo],
      uncaught: false,
      x: 710,
      y: 2820,
      wires: [[IDS.createAck]],
    },
    functionNode(template, IDS.resultSubmitAck, "Acknowledge provisional result game revision", readFn(SOURCE_BY_NODE[IDS.resultSubmitAck]), 4, [
      [IDS.resultSubmitResponse], [IDS.resultSubmitEvent], [IDS.resultSubmitHttpResponse], [IDS.resultSubmitDebug],
    ], 1980, 3900),
    {
      id: IDS.resultSubmitCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch provisional result game revision errors",
      scope: [IDS.resultSubmitMongo],
      uncaught: false,
      x: 1740,
      y: 3980,
      wires: [[IDS.resultSubmitAck]],
    },
    commandOperationNode(
      IDS.resultSubmitIdempotencyRead,
      "Majority read result idempotency identity",
      "read-result-idempotency",
      [[IDS.resultSubmitIdempotencyAck], [IDS.resultSubmitIdempotencyAck]],
      1760,
      3860,
    ),
    functionNode(
      template,
      IDS.resultSubmitIdempotencyAck,
      "Verify durable result idempotency identity",
      readFn(SOURCE_BY_NODE[IDS.resultSubmitIdempotencyAck]),
      3,
      [[IDS.resultSubmitResponse], [IDS.resultSubmitHttpResponse], [IDS.resultSubmitDebug]],
      2020,
      3860,
    ),
    functionNode(template, IDS.resultConfirmAck, "Acknowledge result lifecycle game revision", readFn(SOURCE_BY_NODE[IDS.resultConfirmAck]), 3, [
      [IDS.resultConfirmReplay],
      [IDS.resultConfirmHttpResponse],
      [IDS.resultConfirmDebug],
    ], 2510, 3940),
    {
      id: IDS.resultConfirmCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch result lifecycle game revision errors",
      scope: [IDS.resultConfirmMongo],
      uncaught: false,
      x: 2290,
      y: 4020,
      wires: [[IDS.resultConfirmAck]],
    },
    functionNode(template, IDS.cleanupAck, "Acknowledge split cleanup game revision", readFn(SOURCE_BY_NODE[IDS.cleanupAck]), 2, [
      [IDS.cleanupRecoveryMongo], [IDS.cleanupResponse, IDS.cleanupDebug],
    ], 2030, 2080),
    {
      id: IDS.cleanupCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch split cleanup game revision errors",
      scope: [IDS.cleanupMongo],
      uncaught: false,
      x: 1810,
      y: 2160,
      wires: [[IDS.cleanupAck]],
    },
    commandOperationNode(
      IDS.cleanupRecoveryMongo,
      "Persist split cleanup recovery with majority read-back",
      "persist-cleanup-recovery",
      [[IDS.cleanupRecoveryAck], [IDS.cleanupRecoveryAck]],
      2280,
      2120,
    ),
    functionNode(template, IDS.cleanupRecoveryAck, "Acknowledge split cleanup recovery intent", readFn(SOURCE_BY_NODE[IDS.cleanupRecoveryAck]), 1, [
      [IDS.cleanupResponse, IDS.cleanupDebug],
    ], 2540, 2120),
    functionNode(template, IDS.resultConfirmReplay, "Dispatch durable result side effects", readFn(SOURCE_BY_NODE[IDS.resultConfirmReplay]), 5, [
      [IDS.resultClaimRating],
      [IDS.resultClaimEvent],
      [IDS.resultClaimViva],
      [IDS.resultConfirmHttpResponse],
      [IDS.resultConfirmDebug],
    ], 2070, 3860),
    {
      id: IDS.storeConfig,
      type: "padlhub-legacy-game-command-store",
      name: "Legacy command transaction and recovery store",
      mongoUriEnv: "LK_LEGACY_COMMAND_MONGO_URI",
      databaseNameEnv: "LK_LEGACY_COMMAND_MONGO_DB",
    },
    commandOperationNode(IDS.resultClaimRating, "Claim fenced rating sink", "claim-result-sink", [["cbc3af09f9e929f4"], [IDS.resultConfirmDebug]], 2330, 3820),
    commandOperationNode(IDS.resultClaimEvent, "Claim fenced rating-event sink", "claim-result-sink", [[IDS.resultConfirmEvent], [IDS.resultConfirmDebug]], 2330, 3860),
    commandOperationNode(IDS.resultClaimViva, "Claim at-most-once Viva sink", "claim-result-sink", [[IDS.resultVivaOutboxPrepare], [IDS.resultConfirmDebug]], 2860, 3780),
    commandOperationNode(IDS.resultCompleteRating, "Complete fenced rating sink", "complete-result-sink", [[IDS.resultRatingProjection], [IDS.resultConfirmDebug]], 3660, 3660),
    commandOperationNode(IDS.resultCompleteEvent, "Complete rating-event sink", "complete-result-sink", [[], [IDS.resultConfirmDebug]], 2820, 4020),
    commandOperationNode(IDS.resultCompleteViva, "Complete at-most-once Viva sink", "complete-result-sink", [[IDS.resultVivaAfterCompletion], [IDS.resultConfirmDebug]], 4200, 3820),
    functionNode(template, IDS.resultRatingAck, "Acknowledge fenced rating projection", readFn(SOURCE_BY_NODE[IDS.resultRatingAck]), 1, [[IDS.resultCompleteRating]], 3410, 3660),
    functionNode(template, IDS.resultEventAck, "Acknowledge fenced rating-event lifecycle", readFn(SOURCE_BY_NODE[IDS.resultEventAck]), 1, [[IDS.resultCompleteEvent]], 2580, 4020),
    functionNode(template, IDS.resultVivaOutboxAck, "Gate provider call on durable outbox ACK", readFn(SOURCE_BY_NODE[IDS.resultVivaOutboxAck]), 2, [[IDS.resultVivaIdentityRead], [IDS.resultCompleteViva]], 3570, 3740),
    commandOperationNode(IDS.resultVivaIdentityRead, "Majority read provider outbox identity", "read-provider-outbox-identity", [[IDS.resultVivaRequestPrepare], [IDS.resultCompleteViva]], 3810, 3740),
    functionNode(template, IDS.resultVivaStatusAck, "Acknowledge provider terminal status", readFn(SOURCE_BY_NODE[IDS.resultVivaStatusAck]), 1, [[IDS.resultCompleteViva]], 4170, 3780),
    functionNode(template, IDS.resultVivaAfterCompletion, "Release Viva continuation after outer ACK", readFn(SOURCE_BY_NODE[IDS.resultVivaAfterCompletion]), 2, [[IDS.resultVivaJoin], [IDS.resultVivaSummary]], 4470, 3820),
    {
      id: IDS.resultRatingCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch fenced rating sink writes",
      scope: [IDS.resultRatingLedgerMongo, IDS.resultRatingStateMongo, IDS.resultRatingCompatibilityMongo],
      uncaught: false,
      x: 3330,
      y: 3700,
      wires: [[IDS.resultRatingAck]],
    },
    {
      id: IDS.resultEventCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch rating-event sink write",
      scope: [IDS.resultConfirmEvent],
      uncaught: false,
      x: 2580,
      y: 4060,
      wires: [[IDS.resultEventAck]],
    },
    {
      id: IDS.resultVivaOutboxCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch durable provider outbox write",
      scope: [IDS.resultVivaOutboxPrepare, IDS.resultVivaOutboxMongo],
      uncaught: false,
      x: 3570,
      y: 3700,
      wires: [[IDS.resultVivaOutboxAck]],
    },
    {
      id: IDS.resultVivaStatusCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch provider terminal status write",
      scope: [IDS.resultVivaStatusMongo],
      uncaught: false,
      x: 4170,
      y: 3740,
      wires: [[IDS.resultVivaStatusAck]],
    },
  );

  const byId = new Map(flow.map((node) => [node.id, node]));
  if (byId.size !== flow.length) fail("Candidate contains duplicate node ids");
  for (const node of flow) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!byId.has(targetId)) fail(`Broken wire ${node.id} -> ${targetId}`);
    }
    if (node.type === "function" && Number.isInteger(node.outputs)
      && Array.isArray(node.wires) && node.outputs !== node.wires.length) {
      fail(`Function output count mismatch for ${node.id}`);
    }
  }
  if (flow.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
    fail("Prerequisite candidate changed HTTP routes");
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  const writerAudit = auditLegacyGameRevisionWriters(flow, registry, { stage: "candidate" });
  const changes = flow.flatMap((node) => {
    const prior = before.find((item) => item.id === node.id);
    if (!prior) return [{ id: node.id, kind: "added", changedFields: Object.keys(node).sort() }];
    if (isDeepStrictEqual(prior, node)) return [];
    return [{ id: node.id, kind: "changed", changedFields: changedFields(prior, node) }];
  });
  if (changes.filter((item) => item.kind === "added").length !== 36
    || changes.filter((item) => item.kind === "changed").length !== 47) {
    fail(`Prerequisite candidate change budget mismatch: changed=${changes.filter((item) => item.kind === "changed").length}, added=${changes.filter((item) => item.kind === "added").length}`);
  }
  return { flow, changes, writerAudit };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
  if (!result["--workspace"] || !result["--output"] || !result["--report"]) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
  }
  return result;
}

export function runLegacyGameCommandPrerequisiteBuild(argv) {
  const args = parseArgs(argv);
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256) fail("Live flow preimage SHA mismatch");
  const { flow, changes, writerAudit } = buildLegacyGameCommandPrerequisiteCandidate(verified.source);
  const outputPath = path.resolve(args["--output"]);
  const reportPath = path.resolve(args["--report"]);
  for (const target of [outputPath, reportPath]) {
    if (fs.existsSync(target)) fail(`Refusing to overwrite ${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  }
  const output = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(outputPath, output, { mode: 0o600, flag: "wx" });
  const report = {
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(output),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: flow.length,
    httpRouteCount: EXPECTED_ROUTE_COUNT,
    changes,
    writerAudit,
    endpointAdded: false,
    deploymentPerformed: false,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return report;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runLegacyGameCommandPrerequisiteBuild(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  buildLk1EnforcementCandidate,
  buildUnifiedLk1EnforcementCandidate,
  LK1_ENFORCEMENT_CONTRACT,
  PREVIOUS_LK1_ENFORCEMENT_CANDIDATE_SHA256,
  validateUnifiedCandidateSummary,
} from "../prepare_lk1_subscription_enforcement_candidate.mjs";
import { PAYMENT_NODE_IDS } from "../patch_live_game_payment_confirmation.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function syntheticContract() {
  const flow = [
    { id: "games", type: "tab", label: "LK Games", disabled: false },
    { id: "tournaments", type: "tab", label: "LK Tournaments", disabled: false },
    { id: "a", type: "function", z: "games", name: "A", func: "return msg;\n", wires: [["b"]] },
    { id: "b", type: "function", z: "tournaments", name: "B", func: "return msg;\n", wires: [] },
  ];
  const sources = new Map([
    ["a.js", "msg.a = true;\nreturn msg;\n"],
    ["b.js", "msg.b = true;\nreturn msg;\n"],
  ]);
  const contract = {
    sourceSha256: "source-sha",
    nodeCount: flow.length,
    targets: [
      { id: "a", tabLabel: "LK Games", name: "A", sourceFile: "a.js", preimageSha256: sha256(flow[2].func), candidateSha256: sha256(sources.get("a.js")) },
      { id: "b", tabLabel: "LK Tournaments", name: "B", sourceFile: "b.js", preimageSha256: sha256(flow[3].func), candidateSha256: sha256(sources.get("b.js")) },
    ],
  };
  return { flow, contract, sources };
}

function structuralUnifiedFixture({ omitConfirmReadback = false } = {}) {
  const ids = {
    tab: "4b91e2a2413688db",
    patch: "e0d7883bc1a9fa8c",
    create: "e656cff36a8cd210",
    createMongo: "5eaf4c087c0cc668",
    createAck: "lk_game_create_revision_ack_20260826",
    cleanupPrepare: "9508f8e0ae8d282a",
    cleanupRouter: "bcc3dccf8d64f9bb",
    cleanupMongo: "11079a30bf3cc6ad",
    cleanupAck: "lk_split_cleanup_revision_ack_20260826",
    upsertArgs: "79307f9bcbc28b6c",
    response: "ae5ee70de15fe66e",
    debug: "60a3353902ae9973",
    autojoin: "9756d9125563753f",
    cleanupResponse: "e71d73fb91b0c3f0",
    cleanupDebug: "ba322f367a4d4fcd",
    cleanupRecovery: "lk_split_cleanup_revision_recovery_write_20260826",
  };
  const sourceTexts = new Map();
  const composed = [
    [ids.create, "create.js"],
    [ids.cleanupPrepare, "cleanup-prepare.js"],
    [ids.cleanupRouter, "cleanup-router.js"],
    [ids.upsertArgs, "upsert-args.js"],
    [PAYMENT_NODE_IDS.lookup, "payment-lookup.js"],
    [PAYMENT_NODE_IDS.router, "payment-router.js"],
    [PAYMENT_NODE_IDS.confirmWriteAck, "confirm-ack.js"],
    [PAYMENT_NODE_IDS.cleanupWriteAck, "cleanup-ack.js"],
  ].map(([id, sourceFile]) => {
    const text = `msg.fixture = ${JSON.stringify(id)};\nreturn msg;\n`;
    sourceTexts.set(sourceFile, text);
    return { id, sourceFile, candidateSha256: sha256(text) };
  });
  const patchSource = "msg.fixturePatch = true;\nreturn msg;\n";
  sourceTexts.set("patch.js", patchSource);
  const source = [
    { id: ids.tab, type: "tab", label: "LK Games", disabled: false },
    { id: "fixture-route", type: "http in", z: ids.tab, method: "post", url: "/fixture", wires: [[ids.create]] },
    { id: ids.patch, type: "function", z: ids.tab, name: "Prepare game patch", func: "return msg;\n", outputs: 1, wires: [[]] },
    { id: ids.create, type: "function", z: ids.tab, name: "Prepare game upsert", func: "return msg;\n", outputs: 4, wires: [[], [], [], []] },
    { id: ids.createMongo, type: "mongodb4", z: ids.tab, name: "Upsert lk game", wires: [[]] },
    { id: ids.cleanupPrepare, type: "function", z: ids.tab, name: "Prepare split cleanup tasks", func: "return msg;\n", outputs: 1, wires: [[]] },
    { id: ids.cleanupRouter, type: "function", z: ids.tab, name: "Route split cleanup action", func: "return msg;\n", outputs: 6, wires: [[], [], [], [], [], []] },
    { id: ids.cleanupMongo, type: "mongodb4", z: ids.tab, name: "Archive split game after cleanup", wires: [[]] },
    { id: ids.upsertArgs, type: "function", z: ids.tab, name: "Upsert lk game -> mongodb4 args", func: "return msg;\n", outputs: 1, wires: [[]] },
    ...[ids.response, ids.debug, ids.autojoin, ids.cleanupResponse, ids.cleanupDebug, ids.cleanupRecovery]
      .map((id) => ({ id, type: "debug", z: ids.tab, wires: [] })),
  ];
  const paymentNodes = Object.values(PAYMENT_NODE_IDS)
    .filter((id) => !(omitConfirmReadback && id === PAYMENT_NODE_IDS.confirmWriteReadback))
    .map((id) => ({
      id,
      type: composed.some((item) => item.id === id) ? "function" : "mongodb4",
      z: ids.tab,
      func: composed.some((item) => item.id === id)
        ? sourceTexts.get(composed.find((item) => item.id === id).sourceFile)
        : undefined,
      outputs: composed.some((item) => item.id === id) ? 1 : undefined,
      wires: id === PAYMENT_NODE_IDS.confirmWriteAck
        ? [[PAYMENT_NODE_IDS.confirmWriteReadback]]
        : [[]],
    }));
  const legacyFlow = structuredClone(source);
  legacyFlow.find((node) => node.id === ids.patch).func = patchSource;
  legacyFlow.push(
    { id: ids.createAck, type: "function", z: ids.tab, func: "return msg;\n", outputs: 3, wires: [[], [], []] },
    { id: ids.cleanupAck, type: "function", z: ids.tab, func: "return msg;\n", outputs: 2, wires: [[], []] },
  );
  const candidateNodeCount = source.length + 2 + paymentNodes.length + 2;
  const contract = {
    candidateBindingState: "BOUND",
    sourceSha256: "fixture-source",
    candidateSha256: "6bc008ab4695fadbc7a0a2711cafd2570f881df152f28f430ad038799fb22645",
    previousCandidateSha256: PREVIOUS_LK1_ENFORCEMENT_CANDIDATE_SHA256,
    nodeCount: source.length,
    candidateNodeCount,
    httpRouteCount: 1,
    tabCount: 1,
    changedNodeCount: 23,
    changedExistingNodeCount: 7,
    addedNodeCount: 16,
    writerCount: 7,
    composedSources: composed,
    targets: [{
      id: ids.patch,
      tabLabel: "LK Games",
      name: "Prepare game patch",
      sourceFile: "patch.js",
      preimageSha256: sha256("return msg;\n"),
      candidateSha256: sha256(patchSource),
    }],
  };
  const registry = {
    writers: [
      { nodeId: ids.createMongo, sourceNodes: [{ nodeId: ids.create, candidateSha256: "old" }] },
      { nodeId: ids.cleanupMongo, sourceNodes: [
        { nodeId: ids.cleanupPrepare, candidateSha256: "old" },
        { nodeId: ids.cleanupRouter, candidateSha256: "old" },
      ] },
    ],
  };
  return {
    source,
    contract,
    options: {
      contract,
      registry,
      readSource: (sourceFile) => sourceTexts.get(sourceFile),
      buildPaymentCandidate: (flow) => ({
        candidate: [...flow, ...structuredClone(paymentNodes)],
        report: { changedNodeIds: [] },
      }),
      buildLegacyCandidate: () => ({ flow: structuredClone(legacyFlow), changes: [{}] }),
      auditWriters: () => ({ ok: true, writerCount: 7, sourceChecks: [] }),
    },
  };
}

test("unified LK1 candidate changes only exact function bodies and preserves topology", () => {
  const { flow, contract, sources } = syntheticContract();
  const beforeTopology = flow.map((node) => ({ id: node.id, z: node.z, wires: node.wires }));
  const result = buildLk1EnforcementCandidate(
    structuredClone(flow),
    contract.sourceSha256,
    contract,
    (sourceFile) => sources.get(sourceFile),
  );
  assert.deepEqual(result.changedNodes.map((node) => node.id), ["a", "b"]);
  assert.deepEqual(
    result.candidate.map((node) => ({ id: node.id, z: node.z, wires: node.wires })),
    beforeTopology,
  );
});

test("unified LK1 candidate fails closed on source, preimage, or enabled-tab drift", () => {
  const { flow, contract, sources } = syntheticContract();
  const build = (candidate, sourceSha = contract.sourceSha256) => buildLk1EnforcementCandidate(
    candidate,
    sourceSha,
    contract,
    (sourceFile) => sources.get(sourceFile),
  );
  assert.throws(() => build(structuredClone(flow), "drift"), /live source SHA mismatch/);
  const functionDrift = structuredClone(flow);
  functionDrift[2].func = "return null;\n";
  assert.throws(() => build(functionDrift), /preimage mismatch/);
  const disabledTab = structuredClone(flow);
  disabledTab[0].disabled = true;
  assert.throws(() => build(disabledTab), /enabled-tab mismatch/);
});

test("unified LK1 candidate tolerates disabled duplicates but rejects enabled semantic duplicates", () => {
  const { flow, contract, sources } = syntheticContract();
  const disabledDuplicate = structuredClone(flow);
  disabledDuplicate.push(
    { id: "games-disabled", type: "tab", label: "LK Games", disabled: true },
    {
      id: "a-disabled-copy",
      type: "function",
      z: "games-disabled",
      name: "A",
      func: "return null;\n",
      wires: [],
    },
  );
  const expandedContract = { ...contract, nodeCount: disabledDuplicate.length };
  assert.doesNotThrow(() => buildLk1EnforcementCandidate(
    structuredClone(disabledDuplicate),
    expandedContract.sourceSha256,
    expandedContract,
    (sourceFile) => sources.get(sourceFile),
  ));

  const enabledDuplicate = structuredClone(disabledDuplicate);
  enabledDuplicate.find((node) => node.id === "games-disabled").disabled = false;
  assert.throws(
    () => buildLk1EnforcementCandidate(
      enabledDuplicate,
      expandedContract.sourceSha256,
      expandedContract,
      (sourceFile) => sources.get(sourceFile),
    ),
    /enabled semantic identity must exist exactly once/,
  );
});

test("unified LK1 contract stays fail-closed while amended router and atomic Piter sources are unbound", () => {
  assert.equal(
    LK1_ENFORCEMENT_CONTRACT.sourceSha256,
    "9e9698ea3e7cfa0bd2b42a95a7eed20a82436cb06f40ecd80c13896a1960b263",
  );
  assert.equal(LK1_ENFORCEMENT_CONTRACT.targets.length, 5);
  const expectedUnboundSha256ById = new Map([
    ["lk_subscription_booking_router_20260804", "02cd217c8791dbd0a70928539d05ef5cd44c6b57a8ad763cd6e95893d2f418c1"],
    ["c165e43eba668c25", "e81699c4c490b9883cacf104c751990c0b2922ce86d1f607889fb66991fedb53"],
    ["91dded2dc8cfebe4", "cdaa2b512d6e0f1bc1fd79eb264d1d05816e63d391e6bbf9390eaf29694e0851"],
    ["f8679e53edadc39b", "d7adcfb697bf06428f7e0c3de2dafb111e88d59c480640574d6d2760e4b9b549"],
  ]);
  for (const target of LK1_ENFORCEMENT_CONTRACT.targets) {
    const actualSha256 = sha256(fs.readFileSync(target.sourceFile));
    const expectedUnboundSha256 = expectedUnboundSha256ById.get(target.id);
    if (expectedUnboundSha256) {
      assert.equal(actualSha256, expectedUnboundSha256, target.id);
      assert.notEqual(actualSha256, target.candidateSha256, `${target.id} must stay unbound`);
    } else {
      assert.equal(actualSha256, target.candidateSha256, target.id);
    }
  }
  assert.equal(LK1_ENFORCEMENT_CONTRACT.composedSources.length, 8);
  for (const source of LK1_ENFORCEMENT_CONTRACT.composedSources) {
    assert.equal(sha256(fs.readFileSync(source.sourceFile)), source.candidateSha256, source.id);
  }
});

test("router amendment leaves the full-flow candidate contract explicitly unbound", () => {
  const summary = {
    sourceSha256: LK1_ENFORCEMENT_CONTRACT.sourceSha256,
    candidateSha256: LK1_ENFORCEMENT_CONTRACT.previousCandidateSha256,
    candidateNodeCount: 4812,
    httpRouteCount: 215,
    tabCount: 55,
    changedNodeCount: 104,
    changedExistingNodeCount: 54,
    addedNodeCount: 50,
    writerCount: 7,
    brokenWires: 0,
    brokenLinks: 0,
    splitPricingMutationCount: 0,
    createAckOrder: [
      "lk_game_create_revision_ack_20260826",
      "lk_game_payment_confirm_write_ack_20260826",
      "lk_game_payment_confirm_write_readback_20260826",
    ],
    cleanupAckOrder: [
      "lk_split_cleanup_revision_ack_20260826",
      "lk_split_cleanup_write_ack_20260826",
      "lk_split_cleanup_write_readback_20260826",
    ],
    cleanupRecoveryNode: "lk_split_cleanup_revision_recovery_write_20260826",
  };
  assert.equal(LK1_ENFORCEMENT_CONTRACT.candidateBindingState,
    "UNBOUND_AFTER_ROUTER_AMENDMENT");
  assert.equal(LK1_ENFORCEMENT_CONTRACT.candidateSha256, null);
  assert.throws(
    () => validateUnifiedCandidateSummary(summary),
    /candidate contract is unbound after router amendment/,
  );
  for (const candidateBindingState of [undefined, "TYPO"]) {
    assert.throws(
      () => validateUnifiedCandidateSummary(summary, {
        ...LK1_ENFORCEMENT_CONTRACT,
        candidateBindingState,
        candidateSha256: summary.candidateSha256,
      }),
      /candidate contract is unbound after router amendment/,
    );
  }
  assert.throws(
    () => validateUnifiedCandidateSummary(summary, {
      ...LK1_ENFORCEMENT_CONTRACT,
      candidateBindingState: "BOUND",
      candidateSha256: summary.candidateSha256,
    }),
    /candidate contract is unbound after router amendment/,
  );
  assert.throws(
    () => validateUnifiedCandidateSummary({ ...summary, candidateSha256: "a".repeat(64) }, {
      ...LK1_ENFORCEMENT_CONTRACT,
      candidateBindingState: "BOUND",
      candidateSha256: "a".repeat(64),
      previousCandidateSha256: "e".repeat(64),
    }),
    /candidate contract is unbound after router amendment/,
  );
  const boundCandidateSha256 = "a".repeat(64);
  const boundSummary = { ...summary, candidateSha256: boundCandidateSha256 };
  const boundContract = {
    ...LK1_ENFORCEMENT_CONTRACT,
    candidateBindingState: "BOUND",
    candidateSha256: boundCandidateSha256,
  };
  for (const drift of [
    { candidateSha256: "drift" },
    { changedNodeCount: 105 },
    { brokenWires: 1 },
    { createAckOrder: [...summary.createAckOrder].reverse() },
    { cleanupRecoveryNode: "wrong" },
  ]) {
    assert.throws(
      () => validateUnifiedCandidateSummary({ ...boundSummary, ...drift }, boundContract),
      /reviewed candidate contract mismatch/,
    );
  }
});

test("CI-safe structural fixture executes the full unified composition and rejects missing wiring", () => {
  const fixture = structuralUnifiedFixture();
  const result = buildUnifiedLk1EnforcementCandidate(
    structuredClone(fixture.source),
    fixture.contract.sourceSha256,
    fixture.options,
  );
  assert.equal(result.candidateSha256, fixture.contract.candidateSha256);

  const drift = structuralUnifiedFixture({ omitConfirmReadback: true });
  assert.throws(
    () => buildUnifiedLk1EnforcementCandidate(
      structuredClone(drift.source),
      drift.contract.sourceSha256,
      drift.options,
    ),
    /broken references|exact node/,
  );
});

test("unified publisher rejects a second enabled semantic target before composition", () => {
  const fixture = structuralUnifiedFixture();
  fixture.source.push(
    { id: "duplicate-games-tab", type: "tab", label: "LK Games", disabled: false },
    {
      id: "duplicate-patch-target",
      type: "function",
      z: "duplicate-games-tab",
      name: "Prepare game patch",
      func: "return msg;\n",
      outputs: 1,
      wires: [[]],
    },
  );
  const duplicateContract = { ...fixture.contract, nodeCount: fixture.source.length };
  assert.throws(
    () => buildUnifiedLk1EnforcementCandidate(
      fixture.source,
      duplicateContract.sourceSha256,
      { ...fixture.options, contract: duplicateContract },
    ),
    /Unified LK1 target e0d7883bc1a9fa8c enabled semantic identity must exist exactly once/,
  );
});

test("unified ACK sources require tenant/revision readback and durable cleanup recovery", () => {
  const create = fs.readFileSync("scripts/nodered_games_nodes/fn_create.js", "utf8");
  const confirmAck = fs.readFileSync("scripts/nodered_games_nodes/fn_game_confirm_write_ack.js", "utf8");
  const cleanup = fs.readFileSync("scripts/nodered_games_nodes/fn_split_cleanup_router.js", "utf8");
  const cleanupAck = fs.readFileSync("scripts/nodered_games_nodes/fn_split_cleanup_write_ack.js", "utf8");
  const cleanupRevisionAck = fs.readFileSync(
    "scripts/nodered_legacy_command_prerequisite_nodes/fn_cleanup_revision_ack.js",
    "utf8",
  );

  assert.match(create, /body\.expectedRevision/);
  assert.doesNotMatch(create, /body\.revision/);
  assert.match(create, /tenantKey,\n {2}id: gameId,\n {2}revision:/);
  assert.match(create, /\$inc: \{ revision: 1 \}/);
  assert.match(confirmAck, /tenantKey: ctx\.tenantKey, id: ctx\.gameId, revision: ctx\.expectedNextRevision/);
  assert.match(confirmAck, /Number\(record\.revision\) === Number\(ctx\.expectedNextRevision\)/);
  assert.match(cleanup, /tenantKey: ctx\.sourceTenantKey/);
  assert.match(cleanup, /revision: ctx\.sourceRevision/);
  assert.match(cleanup, /_splitCleanupRevisionDeferred/);
  assert.match(cleanupAck, /return \[null, null, null, msg\]/);
  assert.match(cleanupRevisionAck, /_legacyCleanupRecovery/);
});

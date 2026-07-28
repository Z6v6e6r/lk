import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

type NodeRedMsg = Record<string, unknown>;
type GlobalValues = Record<string, unknown>;

type NodeRedFlowNode = {
  id: string;
  type: string;
  z?: string;
  name?: string;
  label?: string;
  url?: string;
  method?: string;
  disabled?: boolean;
  outputs?: number;
  wires?: string[][];
};

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map((entry) => asRecord(entry));
}

function runNodeRedFunction(file: string, msg: NodeRedMsg, globalValues: GlobalValues = {}) {
  const source = fs.readFileSync(file, "utf8");
  const runtimeGlobals = { ...globalValues };
  const globalContext = {
    get(key: string) {
      return Object.prototype.hasOwnProperty.call(runtimeGlobals, key)
        ? runtimeGlobals[key]
        : undefined;
    },
  };

  const input = JSON.parse(JSON.stringify(msg)) as NodeRedMsg;
  return new Function("msg", "global", source)(input, globalContext);
}

function runReferralFlowScriptsInFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "padlhub-referral-flow-"));
  const activeReferralTabId = "fixture-active-referral-tab";
  const flowPath = path.join(fixtureRoot, "node-red/modular/source.flow.json");
  const importPath = path.join(
    fixtureRoot,
    "node-red/modular/imports/lk_referral_subscription.import.json",
  );

  try {
    fs.mkdirSync(path.dirname(flowPath), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "scripts"), { recursive: true });
    fs.cpSync(
      path.resolve("scripts/nodered_games_nodes"),
      path.join(fixtureRoot, "scripts/nodered_games_nodes"),
      { recursive: true },
    );
    fs.writeFileSync(flowPath, `${JSON.stringify([
      {
        id: "fixture-disabled-referral-tab",
        type: "tab",
        label: "LK Referral Subscriptions",
        disabled: true,
      },
      {
        id: activeReferralTabId,
        type: "tab",
        label: "LK Referral Subscriptions",
        disabled: false,
      },
      {
        id: "4e820638cc39c730",
        type: "mongodb4-client",
        name: "fixture mongo",
      },
    ], null, 2)}\n`, "utf8");

    execFileSync(
      process.execPath,
      [path.resolve("scripts/patch_nodered_referral_subscription_flow.mjs")],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    const patchedFlow = JSON.parse(fs.readFileSync(flowPath, "utf8")) as NodeRedFlowNode[];

    execFileSync(
      process.execPath,
      [path.resolve("scripts/export_nodered_referral_subscription_import.mjs")],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    const importFlow = JSON.parse(fs.readFileSync(importPath, "utf8")) as NodeRedFlowNode[];

    return { activeReferralTabId, patchedFlow, importFlow };
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function findSingleFlowNode(
  flow: NodeRedFlowNode[],
  predicate: (node: NodeRedFlowNode) => boolean,
  description: string,
) {
  const matches = flow.filter(predicate);
  assert.equal(matches.length, 1, `Expected exactly one ${description}, found ${matches.length}`);
  return matches[0];
}

function outputTargets(node: NodeRedFlowNode, outputIndex: number) {
  const targets = node.wires?.[outputIndex];
  assert.ok(Array.isArray(targets), `${node.name || node.id} output ${outputIndex + 1} is missing`);
  return targets;
}

function collectReachableNodeIds(flow: NodeRedFlowNode[], startId: string) {
  const byId = new Map(flow.map((node) => [node.id, node]));
  const reachable = new Set<string>();
  const queue = [startId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId || reachable.has(currentId)) continue;
    reachable.add(currentId);
    const current = byId.get(currentId);
    for (const output of current?.wires || []) {
      for (const targetId of output || []) {
        assert.ok(byId.has(targetId), `${currentId} has dangling wire to ${targetId}`);
        if (!reachable.has(targetId)) queue.push(targetId);
      }
    }
  }

  return reachable;
}

function assertNoDanglingWires(flow: NodeRedFlowNode[]) {
  const nodeIds = new Set(flow.map((node) => node.id));
  for (const node of flow) {
    for (const output of node.wires || []) {
      for (const targetId of output || []) {
        assert.ok(nodeIds.has(targetId), `${node.name || node.id} has dangling wire to ${targetId}`);
      }
    }
  }
}

function withFixedNow<T>(nowIso: string, callback: () => T): T {
  const nowTs = Date.parse(nowIso);
  const originalDateNow = Date.now;
  Date.now = () => nowTs;
  try {
    return callback();
  } finally {
    Date.now = originalDateNow;
  }
}

function buildOwnerResolveMessage(overrides: Record<string, unknown> = {}): NodeRedMsg {
  return {
    _referralSubscriptionCtx: {
      action: "status",
      step: "load_owner_subscription",
      postOwnerStep: "status_query",
      ownerPhone: "79104303190",
      ownerSubscriptionId: "sub-1",
      token: "token-1",
      ownerClientId: "client-1",
      flowType: "share",
    },
    statusCode: 200,
    payload: {
      name: "Лето.Падел.Дружба",
      expirationDate: "2026-06-14",
      status: "ACTIVE",
    },
    ...overrides,
  };
}

test("invite prepare creates opaque invite without exposing owner phone in response payload", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_invite_prepare.js",
    {
      payload: {
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        mode: "share",
      },
    },
  ) as unknown[];

  const dbMsg = asRecord(out[0]);
  const ctx = asRecord(dbMsg._referralSubscriptionInviteCtx);
  const update = asRecord(asRecord(dbMsg.payload).$set);
  assert.match(String(ctx.inviteId), /^refinvite-/);
  assert.equal(update.ownerPhone, "79104303190");
  assert.equal(ctx.responsePayload && asRecord(ctx.responsePayload).ownerPhone, undefined);
});

test("status prepare accepts inviteId without owner phone in query", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_status_prepare.js",
    {
      req: {
        query: {
          inviteId: "refinvite-1",
          mode: "share",
        },
      },
    },
  ) as unknown[];

  const dbMsg = asRecord(out[3]);
  const ctx = asRecord(dbMsg._referralSubscriptionCtx);
  assert.equal(ctx.step, "resolve_invite");
  assert.deepEqual(dbMsg.query, { inviteId: "refinvite-1" });
  assert.deepEqual(dbMsg.payload, { inviteId: "refinvite-1" });
});

test("owner resolve restores owner pair from invite record", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_owner_resolve.js",
    {
      _referralSubscriptionCtx: {
        action: "status",
        step: "resolve_invite",
        postOwnerStep: "status_query",
        inviteId: "refinvite-1",
        flowType: "renewal",
      },
      statusCode: 200,
      payload: [
        {
          inviteId: "refinvite-1",
          ownerPhone: "8 (910) 430-31-90",
          ownerSubscriptionId: "sub-old",
          flowType: "share",
          updatedAt: "2026-06-10T09:00:00.000Z",
        },
        {
          inviteId: "refinvite-1",
          ownerPhone: "+7 910 430-31-90",
          ownerSubscriptionId: "sub-new",
          flowType: "renewal",
          updatedAt: "2026-06-11T09:00:00.000Z",
        },
      ],
    },
  ) as unknown[];

  const requestMsg = asRecord(out[0]);
  const ctx = asRecord(requestMsg._referralSubscriptionCtx);

  assert.equal(ctx.step, "token_owner");
  assert.equal(ctx.ownerPhone, "79104303190");
  assert.equal(ctx.ownerSubscriptionId, "sub-new");
  assert.equal(ctx.flowType, "renewal");
  assert.equal(requestMsg.method, "POST");
});

test("purchase prepare accepts inviteId without owner phone in body", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_purchase_prepare.js",
    {
      payload: {
        inviteId: "refinvite-1",
        clientPhone: "79260000000",
        planKey: "sport",
        mode: "share",
      },
    },
  ) as unknown[];

  const dbMsg = asRecord(out[3]);
  const ctx = asRecord(dbMsg._referralSubscriptionCtx);
  assert.equal(ctx.step, "resolve_invite");
  assert.equal(ctx.planKey, "sport");
  assert.deepEqual(dbMsg.query, { inviteId: "refinvite-1" });
  assert.deepEqual(dbMsg.payload, { inviteId: "refinvite-1" });
});

test("referral patch wires purchase invite lookup on the active referral tab", () => {
  const { activeReferralTabId, patchedFlow } = runReferralFlowScriptsInFixture();
  const activeTab = findSingleFlowNode(
    patchedFlow,
    (node) => (
      node.type === "tab"
      && node.label === "LK Referral Subscriptions"
      && node.disabled !== true
    ),
    "active LK Referral Subscriptions tab",
  );
  const purchaseRoute = findSingleFlowNode(
    patchedFlow,
    (node) => (
      node.type === "http in"
      && node.method === "post"
      && node.url === "/lk/tournaments/referral-subscription/purchase"
    ),
    "referral purchase route",
  );
  const purchasePrepare = findSingleFlowNode(
    patchedFlow,
    (node) => node.type === "function" && node.name === "Prepare referral subscription purchase",
    "referral purchase prepare node",
  );
  const purchaseInviteLookup = findSingleFlowNode(
    patchedFlow,
    (node) => (
      node.type === "mongodb4"
      && node.name === "Find referral subscription invite for purchase"
    ),
    "referral purchase invite lookup node",
  );
  const purchaseOwnerResolve = findSingleFlowNode(
    patchedFlow,
    (node) => (
      node.type === "function"
      && node.name === "Resolve referral subscription owner purchase"
    ),
    "referral purchase owner resolver",
  );
  const purchaseTransactionRequest = findSingleFlowNode(
    patchedFlow,
    (node) => (
      node.type === "http request"
      && node.name === "Viva referral subscription transaction request"
    ),
    "referral purchase transaction request",
  );

  assert.equal(activeTab.id, activeReferralTabId);
  assert.equal(purchaseRoute.z, activeReferralTabId);
  assert.equal(purchasePrepare.z, activeReferralTabId);
  assert.equal(purchaseInviteLookup.z, activeReferralTabId);
  assert.equal(purchaseOwnerResolve.z, activeReferralTabId);
  assert.deepEqual(outputTargets(purchaseRoute, 0), [purchasePrepare.id]);
  assert.equal(purchasePrepare.outputs, 4);
  assert.deepEqual(outputTargets(purchasePrepare, 3), [purchaseInviteLookup.id]);
  assert.deepEqual(outputTargets(purchaseInviteLookup, 0), [purchaseOwnerResolve.id]);

  const reachable = collectReachableNodeIds(patchedFlow, purchaseInviteLookup.id);
  assert.ok(reachable.has(purchaseTransactionRequest.id), "inviteId branch cannot reach purchase");
  assert.ok(
    [...reachable].some((nodeId) => (
      patchedFlow.find((node) => node.id === nodeId)?.type === "http response"
    )),
    "inviteId branch cannot reach an HTTP response",
  );
});

test("referral import preserves purchase invite lookup without dangling wires", () => {
  const { activeReferralTabId, patchedFlow, importFlow } = runReferralFlowScriptsInFixture();
  assertNoDanglingWires(importFlow);
  const importTab = findSingleFlowNode(
    importFlow,
    (node) => (
      node.type === "tab"
      && node.label === "LK Referral Subscriptions"
      && node.disabled !== true
    ),
    "exported LK Referral Subscriptions tab",
  );
  assert.equal(importTab.id, activeReferralTabId);
  assert.equal(importFlow.some((node) => node.type === "mongodb4-client"), false);
  assert.doesNotMatch(JSON.stringify(importFlow), /mongodb(?:\+srv)?:\/\//i);
  const purchasePrepare = findSingleFlowNode(
    importFlow,
    (node) => node.type === "function" && node.name === "Prepare referral subscription purchase",
    "exported referral purchase prepare node",
  );
  const purchaseInviteLookup = findSingleFlowNode(
    importFlow,
    (node) => (
      node.type === "mongodb4"
      && node.name === "Find referral subscription invite for purchase"
    ),
    "exported referral purchase invite lookup node",
  );
  const purchaseOwnerResolve = findSingleFlowNode(
    importFlow,
    (node) => (
      node.type === "function"
      && node.name === "Resolve referral subscription owner purchase"
    ),
    "exported referral purchase owner resolver",
  );

  assert.equal(purchasePrepare.z, importTab.id);
  assert.equal(purchaseInviteLookup.z, importTab.id);
  assert.equal(purchaseOwnerResolve.z, importTab.id);
  assert.deepEqual(outputTargets(purchasePrepare, 3), [purchaseInviteLookup.id]);
  assert.deepEqual(outputTargets(purchaseInviteLookup, 0), [purchaseOwnerResolve.id]);

  const reachable = collectReachableNodeIds(importFlow, purchaseInviteLookup.id);
  assert.ok(
    [...reachable].some((nodeId) => (
      importFlow.find((node) => node.id === nodeId)?.type === "http response"
    )),
    "exported inviteId branch cannot reach an HTTP response",
  );

  const runtimeWithoutReferralTab = patchedFlow.filter((node) => (
    node.id !== activeReferralTabId && node.z !== activeReferralTabId
  ));
  const replacementRuntime = [...runtimeWithoutReferralTab, ...importFlow];
  for (const url of [
    "/lk/tournaments/referral-subscription/invite",
    "/lk/tournaments/referral-subscription/status",
    "/lk/tournaments/referral-subscription/purchase",
    "/lk/tournaments/referral-subscription/confirm",
  ]) {
    assert.equal(
      replacementRuntime.filter((node) => node.type === "http in" && node.url === url).length,
      1,
      `replacement import must keep exactly one route ${url}`,
    );
  }
});

test("confirm prepare passes payment lookup query as mongodb4 payload", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_confirm_prepare.js",
    {
      payload: {
        inviteId: "refinvite-1",
        paymentRef: "pay-ref-1",
        planKey: "friendship",
        mode: "renewal",
      },
    },
  ) as unknown[];

  const dbMsg = asRecord(out[0]);
  const expectedQuery = {
    inviteId: "refinvite-1",
    paymentRef: "pay-ref-1",
    planKey: "friendship",
  };
  assert.deepEqual(dbMsg.query, expectedQuery);
  assert.deepEqual(dbMsg.payload, expectedQuery);
});

test("owner resolve keeps share flow active before countdown and stores cycle key", () => {
  const out = withFixedNow("2026-06-10T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_owner_resolve.js",
    buildOwnerResolveMessage(),
  )) as unknown[];

  const dbMsg = asRecord(out[1]);
  const ctx = asRecord(dbMsg._referralSubscriptionCtx);
  assert.deepEqual(dbMsg.query, {
    ownerPhone: "79104303190",
    ownerSubscriptionId: "sub-1",
  });
  assert.deepEqual(dbMsg.payload, {
    ownerPhone: "79104303190",
    ownerSubscriptionId: "sub-1",
  });
  assert.equal(ctx.flowType, "share");
  assert.equal(ctx.ownerPlanKey, "friendship");
  assert.equal(ctx.ownerCycleKey, "sub-1:2026-06-14");
  assert.equal(ctx.windowActive, false);
  assert.equal(ctx.countdownVisible, false);
  assert.equal(ctx.windowEndsAt, "2026-06-17T21:00:00.000Z");
});

test("owner resolve allows renewal during grace window after expiration for inactive subscription", () => {
  const out = withFixedNow("2026-06-16T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_owner_resolve.js",
    buildOwnerResolveMessage({
      _referralSubscriptionCtx: {
        action: "status",
        step: "load_owner_subscription",
        postOwnerStep: "status_query",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        token: "token-1",
        ownerClientId: "client-1",
        flowType: "renewal",
      },
      payload: {
        name: "Лето.Падел.Дружба",
        expirationDate: "2026-06-14",
        status: "EXPIRED",
      },
    }),
  )) as unknown[];

  const dbMsg = asRecord(out[1]);
  const ctx = asRecord(dbMsg._referralSubscriptionCtx);
  assert.equal(ctx.flowType, "renewal");
  assert.equal(ctx.windowActive, true);
  assert.equal(ctx.countdownVisible, true);
  assert.equal(ctx.ownerCycleKey, "sub-1:2026-06-14");
});

test("owner resolve blocks renewal after grace window ends", () => {
  const out = withFixedNow("2026-06-17T21:00:01.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_owner_resolve.js",
    buildOwnerResolveMessage({
      _referralSubscriptionCtx: {
        action: "status",
        step: "load_owner_subscription",
        postOwnerStep: "status_query",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        token: "token-1",
        ownerClientId: "client-1",
        flowType: "renewal",
      },
    }),
  )) as unknown[];

  const responseMsg = asRecord(out[2]);
  assert.equal(responseMsg.statusCode, 410);
  assert.match(String(asRecord(responseMsg.payload).error), /реферальной страниц/i);
});

test("owner resolve falls back to get_sub_name when Viva subscription payload has no name", () => {
  const lookupRequest = withFixedNow("2026-06-10T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_owner_resolve.js",
    buildOwnerResolveMessage({
      payload: {
        expirationDate: "2026-06-14",
        status: "ACTIVE",
      },
    }),
  )) as unknown[];

  const requestMsg = asRecord(lookupRequest[0]);
  const requestCtx = asRecord(requestMsg._referralSubscriptionCtx);
  assert.equal(requestCtx.step, "lookup_owner_subscription_name");
  assert.match(String(requestMsg.url), /type=get_sub_name/);
  assert.match(String(requestMsg.url), /subId=sub-1/);

  const resolved = withFixedNow("2026-06-10T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_owner_resolve.js",
    {
      ...requestMsg,
      statusCode: 200,
      payload: {
        sertName: "Лето.Падел.Спорт",
      },
    },
  )) as unknown[];

  const dbMsg = asRecord(resolved[1]);
  const ctx = asRecord(dbMsg._referralSubscriptionCtx);
  assert.equal(ctx.ownerSubscriptionName, "Лето.Падел.Спорт");
  assert.equal(ctx.ownerPlanKey, "sport");
  assert.equal(ctx.ownerCycleKey, "sub-1:2026-06-14");
});

test("status response isolates share reservations by cycle and flow type", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_status_response.js",
    {
      _referralSubscriptionCtx: {
        action: "status",
        flowType: "share",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        ownerSubscriptionName: "Лето.Падел.Дружба",
        ownerPlanKey: "friendship",
        expirationDate: "2026-06-14",
        windowStartsAt: "2026-06-12T21:00:00.000Z",
        windowEndsAt: "2026-06-17T21:00:00.000Z",
        windowActive: false,
        countdownVisible: false,
      },
      payload: [
        {
          flowType: "share",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          planKey: "sport",
          paymentStatus: "PAID",
          subscriptionStatus: "ISSUED",
          updatedAt: "2026-06-14T06:00:00.000Z",
        },
        {
          flowType: "share",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          planKey: "academy",
          paymentStatus: "PAYMENT_PENDING",
          paymentExpiresAt: "2026-06-14T12:00:00.000Z",
        },
        {
          flowType: "renewal",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          planKey: "friendship",
          paymentStatus: "PAID",
        },
        {
          flowType: "share",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-05-14",
          planKey: "ra",
          paymentStatus: "PAID",
        },
      ],
    },
  )) as unknown[];

  const responseMsg = asRecord(out[0]);
  const payload = asRecord(responseMsg.payload);
  const owner = asRecord(payload.owner);
  const plans = asRecordList(payload.plans);
  const sport = plans.find((entry) => entry.planKey === "sport");
  const academy = plans.find((entry) => entry.planKey === "academy");
  const friendship = plans.find((entry) => entry.planKey === "friendship");
  const ra = plans.find((entry) => entry.planKey === "ra");

  assert.equal(owner.flowType, "share");
  assert.equal(owner.ownerCycleKey, "sub-1:2026-06-14");
  assert.equal(sport?.paidCount, 1);
  assert.equal(sport?.remainingCount, 0);
  assert.equal(academy?.reservedCount, 1);
  assert.equal(academy?.activePaymentExpiresAt, "2026-06-14T12:00:00.000Z");
  assert.equal(friendship?.canPurchase, true);
  assert.equal(ra?.remainingCount, 1);
});

test("status response locks renewal after paid record and returns only owner plan", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_status_response.js",
    {
      _referralSubscriptionCtx: {
        action: "status",
        flowType: "renewal",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        ownerSubscriptionName: "Лето.Падел.Дружба",
        ownerPlanKey: "friendship",
        expirationDate: "2026-06-14",
        windowStartsAt: "2026-06-12T21:00:00.000Z",
        windowEndsAt: "2026-06-17T21:00:00.000Z",
        windowActive: true,
        countdownVisible: true,
      },
      payload: [
        {
          flowType: "renewal",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          planKey: "friendship",
          paymentStatus: "PAID",
          subscriptionStatus: "PENDING_ISSUE",
        },
        {
          flowType: "share",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          planKey: "sport",
          paymentStatus: "PAID",
        },
      ],
    },
  )) as unknown[];

  const responseMsg = asRecord(out[0]);
  const payload = asRecord(responseMsg.payload);
  const owner = asRecord(payload.owner);
  const plans = asRecordList(payload.plans);
  assert.equal(owner.flowType, "renewal");
  assert.equal(owner.renewalPurchased, true);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].planKey, "friendship");
  assert.equal(plans[0].canPurchase, false);
  assert.equal(plans[0].paymentStatus, "PAID");
  assert.equal(plans[0].subscriptionStatus, "PENDING_ISSUE");
});

test("purchase limit starts Viva transaction when share slot is free", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_purchase_limit.js",
    {
      _referralSubscriptionCtx: {
        action: "purchase",
        flowType: "share",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        clientPhone: "79260000000",
        clientId: "client-2",
        planKey: "sport",
        ownerPlanKey: "friendship",
        productId: "product-sport",
        token: "token-1",
        reservationMinutes: 30,
      },
      payload: [],
    },
  ) as unknown[];

  const requestMsg = asRecord(out[0]);
  const requestCtx = asRecord(requestMsg._referralSubscriptionCtx);
  assert.equal(requestMsg.method, "POST");
  assert.equal(requestMsg.url, "https://api.vivacrm.ru/api/v1/transactions");
  assert.equal(requestCtx.step, "create_transaction");
  assert.equal(requestCtx.remainingBefore, 1);
});

test("purchase limit reuses live pending payment for same client", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_purchase_limit.js",
    {
      _referralSubscriptionCtx: {
        action: "purchase",
        flowType: "share",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        clientPhone: "79260000000",
        clientId: "client-2",
        planKey: "ra",
        ownerPlanKey: "friendship",
        productId: "product-ra",
        token: "token-1",
      },
      payload: [
        {
          flowType: "share",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          clientPhone: "79260000000",
          clientId: "client-2",
          planKey: "ra",
          paymentRef: "pay-existing",
          paymentUrl: "https://pay.example/renew",
          paymentExpiresAt: "2026-06-14T12:00:00.000Z",
          paymentStatus: "PAYMENT_PENDING",
          subscriptionStatus: "NOT_REQUESTED",
          transactionId: "txn-2",
        },
      ],
    },
  )) as unknown[];

  const responseMsg = asRecord(out[1]);
  const payload = asRecord(responseMsg.payload);
  assert.equal(responseMsg.statusCode, 200);
  assert.equal(payload.reusedExistingPayment, true);
  assert.equal(payload.paymentRef, "pay-existing");
  assert.equal(payload.paymentUrl, "https://pay.example/renew");
});

test("purchase limit blocks finalized renewal slot", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_purchase_limit.js",
    {
      _referralSubscriptionCtx: {
        action: "purchase",
        flowType: "renewal",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        clientPhone: "79260000000",
        clientId: "client-2",
        planKey: "friendship",
        ownerPlanKey: "friendship",
        productId: "product-friendship",
        token: "token-1",
      },
      payload: [
        {
          flowType: "renewal",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          planKey: "friendship",
          paymentStatus: "PAID",
          subscriptionStatus: "ISSUED",
        },
      ],
    },
  ) as unknown[];

  const responseMsg = asRecord(out[1]);
  assert.equal(responseMsg.statusCode, 409);
  assert.match(String(asRecord(responseMsg.payload).error), /оплачено/i);
});

test("purchase limit blocks renewal for another plan than owner's plan", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_purchase_limit.js",
    {
      _referralSubscriptionCtx: {
        action: "purchase",
        flowType: "renewal",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        clientPhone: "79260000000",
        clientId: "client-2",
        planKey: "sport",
        ownerPlanKey: "friendship",
        productId: "product-sport",
        token: "token-1",
      },
      payload: [],
    },
  ) as unknown[];

  const responseMsg = asRecord(out[1]);
  assert.equal(responseMsg.statusCode, 403);
  assert.match(String(asRecord(responseMsg.payload).error), /только текущий тип подписки/i);
});

test("purchase limit blocks live pending payment reserved by another client", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_purchase_limit.js",
    {
      _referralSubscriptionCtx: {
        action: "purchase",
        flowType: "share",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        clientPhone: "79260000000",
        clientId: "client-2",
        planKey: "sport",
        ownerPlanKey: "friendship",
        productId: "product-sport",
        token: "token-1",
      },
      payload: [
        {
          flowType: "share",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          clientPhone: "79991112233",
          clientId: "client-9",
          planKey: "sport",
          paymentRef: "pay-other-client",
          paymentUrl: "https://pay.example/other",
          paymentExpiresAt: "2026-06-14T12:00:00.000Z",
          paymentStatus: "PAYMENT_PENDING",
          subscriptionStatus: "NOT_REQUESTED",
          transactionId: "txn-other",
        },
      ],
    },
  )) as unknown[];

  const responseMsg = asRecord(out[1]);
  assert.equal(responseMsg.statusCode, 409);
  assert.match(String(asRecord(responseMsg.payload).error), /временно занят другим платежом/i);
});

test("purchase resolve accepts Viva payment url from cardPaymentInfo", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_purchase_resolve.js",
    {
      _referralSubscriptionCtx: {
        action: "purchase",
        step: "create_transaction",
        flowType: "share",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        ownerSubscriptionName: "Лето.Падел.Дружба",
        ownerPlanKey: "friendship",
        clientPhone: "79260000000",
        clientId: "client-2",
        planKey: "ra",
        productId: "product-ra",
        productName: "Лето.Падел.РА",
        productCostMinor: 2380000,
        paymentRef: "pay-ref-card-info",
        reservationMinutes: 30,
        remainingBefore: 1,
      },
      statusCode: 200,
      payload: {
        id: "txn-card-info",
        toPay: 2380000,
        cardPaymentInfo: {
          paymentId: "pay-1",
          paymentUrl: "https://pay.tbank.ru/referral-card-info",
          status: "NEW",
        },
        paymentDueDate: "2026-06-14T12:00:00.000Z",
      },
    },
  )) as unknown[];

  const dbMsg = asRecord(out[1]);
  const updateDoc = asRecord(asRecord(dbMsg.payload).$set);
  const responseMsg = asRecord(out[2]);
  const payload = asRecord(responseMsg.payload);

  assert.equal(updateDoc.paymentUrl, "https://pay.tbank.ru/referral-card-info");
  assert.equal(updateDoc.paymentStatus, "PAYMENT_PENDING");
  assert.equal(responseMsg.statusCode, 201);
  assert.equal(payload.paymentUrl, "https://pay.tbank.ru/referral-card-info");
  assert.equal(payload.transactionId, "txn-card-info");
});

test("confirm resolve returns issued record immediately", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_confirm_resolve.js",
    {
      _referralSubscriptionCtx: {
        action: "confirm",
        step: "resolve_record",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        paymentRef: "pay-ref-1",
      },
      payload: [
        {
          flowType: "share",
          ownerPhone: "79104303190",
          ownerSubscriptionId: "sub-1",
          ownerCycleKey: "sub-1:2026-06-14",
          planKey: "academy",
          paymentRef: "pay-ref-1",
          transactionId: "txn-1",
          paymentStatus: "PAID",
          subscriptionStatus: "ISSUED",
          issuedSubscriptionId: "issued-1",
          issuedAt: "2026-06-14T09:00:00.000Z",
          issuedExpirationDate: "2026-07-14",
        },
      ],
    },
  ) as unknown[];

  const responseMsg = asRecord(out[2]);
  const payload = asRecord(responseMsg.payload);
  assert.equal(responseMsg.statusCode, 200);
  assert.equal(payload.status, "ISSUED");
  assert.equal(payload.paymentStatus, "PAID");
  assert.equal(payload.subscriptionStatus, "ISSUED");
  assert.equal(payload.issuedSubscriptionId, "issued-1");
});

test("confirm lookup stores paid payment separately from subscription issuance", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_confirm_resolve.js",
    {
      _referralSubscriptionCtx: {
        action: "confirm",
        step: "confirm_lookup",
        flowType: "renewal",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        planKey: "friendship",
        paymentRef: "pay-ref-2",
        transactionId: "txn-2",
        reservationMinutes: 30,
      },
      statusCode: 200,
      payload: {
        status: "PAID",
        toPay: 0,
      },
    },
  )) as unknown[];

  const dbMsg = asRecord(out[1]);
  const updateDoc = asRecord(asRecord(dbMsg.payload).$set);
  const responseMsg = asRecord(out[2]);
  const payload = asRecord(responseMsg.payload);

  assert.equal(updateDoc.paymentStatus, "PAID");
  assert.equal(updateDoc.subscriptionStatus, "PENDING_ISSUE");
  assert.equal(payload.paid, true);
  assert.equal(payload.failed, false);
  assert.equal(payload.subscriptionStatus, "PENDING_ISSUE");
});

test("confirm lookup keeps Viva card payment url for pending payment", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_confirm_resolve.js",
    {
      _referralSubscriptionCtx: {
        action: "confirm",
        step: "confirm_lookup",
        flowType: "share",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        planKey: "ra",
        paymentRef: "pay-ref-card-pending",
        transactionId: "txn-card-pending",
        reservationMinutes: 30,
      },
      statusCode: 200,
      payload: {
        status: "WAITING",
        toPay: 2380000,
        cardPaymentInfo: {
          paymentId: "pay-2",
          paymentUrl: "https://pay.tbank.ru/referral-card-pending",
          status: "NEW",
        },
        paymentDueDate: "2026-06-14T12:00:00.000Z",
      },
    },
  )) as unknown[];

  const dbMsg = asRecord(out[1]);
  const updateDoc = asRecord(asRecord(dbMsg.payload).$set);
  const responseMsg = asRecord(out[2]);
  const payload = asRecord(responseMsg.payload);

  assert.equal(updateDoc.paymentStatus, "PAYMENT_PENDING");
  assert.equal(updateDoc.paymentUrl, "https://pay.tbank.ru/referral-card-pending");
  assert.equal(payload.paymentStatus, "PAYMENT_PENDING");
  assert.equal(payload.paymentUrl, "https://pay.tbank.ru/referral-card-pending");
});

test("confirm lookup marks subscription issued after Viva subscription scan", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_confirm_resolve.js",
    {
      _referralSubscriptionCtx: {
        action: "confirm",
        step: "lookup_client_subscriptions",
        flowType: "share",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        planKey: "sport",
        paymentRef: "pay-ref-3",
        clientId: "client-2",
        expirationDate: "2026-06-14",
        _paymentUrl: "https://pay.example/sport",
        _paymentExpiresAt: "2026-06-14T12:00:00.000Z",
      },
      statusCode: 200,
      payload: [
        {
          id: "sub-old",
          name: "Лето.Падел.Спорт",
          expirationDate: "2026-06-14",
          status: "EXPIRED",
          updatedAt: "2026-06-13T09:00:00.000Z",
        },
        {
          id: "sub-new",
          name: "Лето.Падел.Спорт",
          expirationDate: "2026-07-14",
          status: "ACTIVE",
          updatedAt: "2026-06-14T09:00:00.000Z",
        },
      ],
    },
  )) as unknown[];

  const dbMsg = asRecord(out[1]);
  const updateDoc = asRecord(asRecord(dbMsg.payload).$set);
  const responseMsg = asRecord(out[2]);
  const payload = asRecord(responseMsg.payload);

  assert.equal(updateDoc.subscriptionStatus, "ISSUED");
  assert.equal(updateDoc.issuedSubscriptionId, "sub-new");
  assert.equal(payload.subscriptionStatus, "ISSUED");
  assert.equal(payload.issuedSubscriptionId, "sub-new");
});

test("confirm lookup keeps paid record pending issue when Viva has no matching new subscription yet", () => {
  const out = withFixedNow("2026-06-14T09:00:00.000Z", () => runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_referral_subscription_confirm_resolve.js",
    {
      _referralSubscriptionCtx: {
        action: "confirm",
        step: "lookup_client_subscriptions",
        flowType: "share",
        ownerPhone: "79104303190",
        ownerSubscriptionId: "sub-1",
        ownerCycleKey: "sub-1:2026-06-14",
        planKey: "sport",
        paymentRef: "pay-ref-pending",
        clientId: "client-2",
        expirationDate: "2026-06-14",
        _paymentUrl: "https://pay.example/sport",
        _paymentExpiresAt: "2026-06-14T12:00:00.000Z",
      },
      statusCode: 200,
      payload: [
        {
          id: "sub-old",
          name: "Лето.Падел.Спорт",
          expirationDate: "2026-06-14",
          status: "EXPIRED",
          updatedAt: "2026-06-14T08:55:00.000Z",
        },
      ],
    },
  )) as unknown[];

  const dbMsg = asRecord(out[1]);
  const updateDoc = asRecord(asRecord(dbMsg.payload).$set);
  const responseMsg = asRecord(out[2]);
  const payload = asRecord(responseMsg.payload);

  assert.equal(updateDoc.subscriptionStatus, "PENDING_ISSUE");
  assert.equal(payload.subscriptionStatus, "PENDING_ISSUE");
  assert.equal(payload.issuedSubscriptionId, null);
});

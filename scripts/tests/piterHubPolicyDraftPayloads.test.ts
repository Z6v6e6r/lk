import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

type DraftRequest = {
  storefront: string;
  typeCode: string;
  typeRequest: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: { code: string; title: string; description: string };
  };
  policyVersionRequest: {
    method: string;
    pathTemplate: string;
    headers: Record<string, string>;
    body: {
      effectiveAt: string;
      applyTo: string;
      validityDays: number;
      createGame: { enabled: boolean; durationsMinutes: number[] };
      joinGame: { enabled: boolean; minDurationMinutes: number; maxDurationMinutes: number };
      maxActiveServices: number;
      activeServicesLimit: { enabled: boolean; max: number | null; scope: string };
      bookingWindowDays: number;
      bookingWindow: { enabled: boolean; days: number | null };
      dailyUsageLimit: number;
      activeServiceScope: string;
      usageUnitsByDuration: Record<"60" | "90" | "120", number>;
      stationAccessRules: Array<{
        ruleId: string;
        enabled: boolean;
        priority: number;
        selector: { kind: string; stationIds: string[] };
        surcharge: { kind: string; amountMinor: number };
      }>;
      benefitRules: unknown[];
      providerBinding: { provider: string; externalId: string; referenceKind: string };
    };
  };
  expectedRuntimeControlsAfterCupNormalization: {
    activeServicesLimit: { enabled: boolean; max: number | null; scope: string };
    bookingWindow: { enabled: boolean; days: number | null };
    dailyUsageLimit: number;
    weeklyUsageLimit: number | null;
    monthlyUsageLimit: number | null;
    maxFutureBookings: number | null;
    minHoursBetweenUses: number;
    allowBookingsAfterExpiry: boolean;
  };
};

const artifact = JSON.parse(fs.readFileSync(
  "architecture-workspace/evidence/subscriptions/PITER_HUB_POLICY_DRAFT_PAYLOADS.json",
  "utf8",
)) as {
  status: string;
  mutationAllowed: boolean;
  cupContract: { gitSha: string; requiredPermission: string };
  candidateContract: {
    branch: string;
    baseGitSha: string;
    candidateGitSha: string;
    released: boolean;
    activationPayload: {
      activationMode: string;
      activationWindowDays: number;
      fixedActivationAt: string;
      fixedActivationTimeZone: string;
      validityDays: number;
    };
  };
  executionBoundary: Record<string, boolean | null>;
  requestedActivationRule: {
    appliesToStorefronts: string[];
    mode: string;
    firstUseTrigger: string;
    automaticActivationAt: string;
    timeZone: string;
    validityStartsAt: string;
    validityDays: number;
    contractRepresentation: string;
    providerReadBackRequired: boolean;
  };
  commonPublicationBlockers: string[];
  normalizationNotes: string[];
  drafts: DraftRequest[];
};

const byStorefront = new Map(artifact.drafts.map((draft) => [draft.storefront, draft]));

test("Piter and HUB artifacts contain DRAFT-only CUP requests and no publication command", () => {
  assert.equal(artifact.status, "DRAFT_ONLY");
  assert.equal(artifact.mutationAllowed, false);
  assert.equal(artifact.cupContract.gitSha, "c4e295fb59177a38de7c908aa05a2535e229033f");
  assert.equal(artifact.cupContract.requiredPermission, "subscriptions:catalog:write");
  assert.equal(artifact.executionBoundary.createDraftTypes, false);
  assert.equal(artifact.executionBoundary.createDraftPolicyVersions, false);
  assert.equal(artifact.executionBoundary.publishPolicyVersions, false);
  assert.equal(artifact.executionBoundary.activateRuntime, false);
  assert.equal(artifact.executionBoundary.publishRequest, null);
  assert.deepEqual([...byStorefront.keys()].sort(), ["network_friendship", "piter_friendship"]);
  assert.ok(artifact.commonPublicationBlockers.includes("CUP_PUBLISH_COMMAND_NOT_IMPLEMENTED"));
  assert.ok(artifact.commonPublicationBlockers.includes("NODE_RED_RUNTIME_BINDING_NOT_RELEASED"));
  assert.ok(artifact.commonPublicationBlockers.includes("CUP_CAPABILITIES_DEFAULTS_NOT_BUSINESS_APPROVED"));
  assert.ok(artifact.commonPublicationBlockers.includes("EXISTING_SALES_INSTANCE_IMPORT_NOT_APPROVED"));
  assert.ok(artifact.commonPublicationBlockers.includes("CREATE_90_120_ADD_ON_NOT_CONFIGURED"));
  assert.ok(artifact.commonPublicationBlockers.includes(
    "CUP_HYBRID_ACTIVATION_CONTRACT_NOT_RELEASED",
  ));
  assert.ok(artifact.commonPublicationBlockers.includes(
    "VIVA_AUTO_ACTIVATION_WRITE_READBACK_NOT_VERIFIED",
  ));
  assert.ok(artifact.normalizationNotes.some((note) => note.includes("bookingWindow.enabled=false")));
  assert.ok(artifact.normalizationNotes.some((note) => note.includes("SubscriptionInstance import")));
});

test("requested activation is first confirmed booking with a fixed 1 October fallback", () => {
  assert.deepEqual(artifact.requestedActivationRule, {
    appliesToStorefronts: ["piter_friendship", "network_friendship"],
    mode: "FIRST_CONFIRMED_BOOKING_OR_FIXED_DATE",
    firstUseTrigger: "FIRST_CONFIRMED_SUBSCRIPTION_BOOKING",
    automaticActivationAt: "2026-10-01T00:00:00+03:00",
    timeZone: "Europe/Moscow",
    validityStartsAt: "EARLIER_OF_FIRST_CONFIRMED_BOOKING_AND_AUTOMATIC_ACTIVATION_AT",
    validityDays: 365,
    contractRepresentation: "SUPPORTED_BY_UNRELEASED_CUP_CANDIDATE",
    providerReadBackRequired: true,
  });

  assert.deepEqual(artifact.candidateContract, {
    branch: "codex/subscription-first-use-deadline-20260820",
    baseGitSha: "c4e295fb59177a38de7c908aa05a2535e229033f",
    candidateGitSha: "6adc6c8c64b403d12e1983020a3c23575ced6145",
    released: false,
    activationPayload: {
      activationMode: "FIRST_USE_OR_FIXED_DATE",
      activationWindowDays: 0,
      fixedActivationAt: "2026-09-30T21:00:00.000Z",
      fixedActivationTimeZone: "Europe/Moscow",
      validityDays: 365,
    },
  });

  for (const draft of artifact.drafts) {
    assert.equal("capabilities" in draft.policyVersionRequest.body, false);
  }
  assert.ok(artifact.normalizationNotes.some((note) => (
    note.includes("effectiveAt") && note.includes("not the activation date")
  )));
  assert.ok(artifact.normalizationNotes.some((note) => note.includes("mutually exclusive modes")));
  assert.ok(artifact.normalizationNotes.some((note) => note.includes("unreleased")));
  assert.ok(artifact.normalizationNotes.some((note) => note.includes("capabilities remain outside")));
});

test("both request bodies match the supported first runtime policy invariant", () => {
  for (const draft of artifact.drafts) {
    assert.match(draft.typeCode, /^[a-z0-9][a-z0-9_-]{2,63}$/);
    assert.equal(draft.typeRequest.method, "POST");
    assert.equal(draft.typeRequest.path, "/api/v1/admin/subscription-types");
    assert.equal(draft.typeRequest.body.code, draft.typeCode);
    assert.ok(draft.typeRequest.body.title.length <= 160);
    assert.ok(draft.typeRequest.body.description.length <= 1000);

    assert.equal(draft.policyVersionRequest.method, "POST");
    assert.equal(
      draft.policyVersionRequest.pathTemplate,
      "/api/v1/admin/subscription-types/{subscriptionTypeId}/policy-versions",
    );
    for (const headers of [draft.typeRequest.headers, draft.policyVersionRequest.headers]) {
      assert.ok(headers["Idempotency-Key"].length >= 16 && headers["Idempotency-Key"].length <= 128);
      assert.ok(headers["X-Correlation-Id"].length >= 8 && headers["X-Correlation-Id"].length <= 128);
    }

    const policy = draft.policyVersionRequest.body;
    assert.equal(Number.isNaN(Date.parse(policy.effectiveAt)), false);
    assert.equal(policy.applyTo, "NEW_ONLY");
    assert.equal(policy.validityDays, 365);
    assert.deepEqual(policy.createGame, { enabled: true, durationsMinutes: [60] });
    assert.deepEqual(policy.joinGame, {
      enabled: true,
      minDurationMinutes: 60,
      maxDurationMinutes: 120,
    });
    assert.equal(policy.maxActiveServices, 0);
    assert.deepEqual(policy.activeServicesLimit, {
      enabled: false,
      max: null,
      scope: "SUBSCRIPTION_BENEFIT_ONLY",
    });
    assert.deepEqual(policy.bookingWindow, { enabled: false, days: null });
    assert.equal(policy.dailyUsageLimit, 1);
    assert.equal(policy.activeServiceScope, "SUBSCRIPTION_BENEFIT_ONLY");
    assert.deepEqual(policy.usageUnitsByDuration, { "60": 1, "90": 1, "120": 1 });
    assert.deepEqual(policy.benefitRules, []);
    assert.deepEqual(draft.expectedRuntimeControlsAfterCupNormalization, {
      activeServicesLimit: {
        enabled: false,
        max: null,
        scope: "SUBSCRIPTION_BENEFIT_ONLY",
      },
      bookingWindow: { enabled: false, days: null },
      dailyUsageLimit: 1,
      weeklyUsageLimit: null,
      monthlyUsageLimit: null,
      maxFutureBookings: null,
      minHoursBetweenUses: 0,
      allowBookingsAfterExpiry: false,
    });
  }
});

test("Piter is station-scoped and HUB is all-stations with exact Viva product candidates", () => {
  const piter = byStorefront.get("piter_friendship");
  const hub = byStorefront.get("network_friendship");
  assert.ok(piter);
  assert.ok(hub);

  assert.deepEqual(piter.policyVersionRequest.body.stationAccessRules, [{
    ruleId: "piter-station-only",
    enabled: true,
    priority: 100,
    selector: {
      kind: "STATION_LIST",
      stationIds: ["1ea77cbf-bc36-49a1-96d6-f35c216a409b"],
    },
    surcharge: { kind: "NONE", amountMinor: 0 },
  }]);
  assert.deepEqual(piter.policyVersionRequest.body.providerBinding, {
    provider: "VIVA",
    externalId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    referenceKind: "PRODUCT_CANDIDATE",
  });

  assert.deepEqual(hub.policyVersionRequest.body.stationAccessRules, [{
    ruleId: "hub-all-stations",
    enabled: true,
    priority: 100,
    selector: { kind: "ALL_STATIONS", stationIds: [] },
    surcharge: { kind: "NONE", amountMinor: 0 },
  }]);
  assert.deepEqual(hub.policyVersionRequest.body.providerBinding, {
    provider: "VIVA",
    externalId: "db7a5250-7369-4f43-8ac5-9111be24bc74",
    referenceKind: "PRODUCT_CANDIDATE",
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync("src/utils/referralSubscription.ts", "utf8");

function extractFunctionBlock(marker: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Cannot find marker: ${marker}`);

  const bodyStart = source.indexOf("{", start);
  assert.ok(bodyStart >= 0, `Cannot find body for: ${marker}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  assert.fail(`Cannot extract function body for: ${marker}`);
}

function toRuntimeBlock(marker: string) {
  return extractFunctionBlock(marker).replace(/^export\s+/, "");
}

function transpileRuntime(code: string) {
  return ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}

function buildRuntime(isDevReleaseChannel: boolean) {
  return new Function(`
  ${transpileRuntime(`
    const IS_DEV_RELEASE_CHANNEL = ${isDevReleaseChannel ? "true" : "false"};
    const PUBLIC_INVITE_ORIGIN = "https://padlhub.ru";
    const REFERRAL_PAGE_PATH = "/ab_leto_referral";
    const REFERRAL_STORAGE_KEY_PREFIX = "padlhub.referral-window.v1";
    const DAY_MS = 24 * 60 * 60 * 1000;
    const MOSCOW_UTC_OFFSET = "+03:00";
    const REFERRAL_DEV_PILOT_PHONES = new Set([
      "79104303190",
      "79266057141",
      "79603075826",
      "79998009669",
      "79261475290",
      "79035107512",
    ]);
    ${extractFunctionBlock("function trimText")}
    ${toRuntimeBlock("export function normalizeReferralPhone")}
    ${extractFunctionBlock("function normalizeDateOnly")}
    ${extractFunctionBlock("function normalizePlanKeyFromName")}
    ${extractFunctionBlock("function buildOwnerCycleKey")}
    ${toRuntimeBlock("export function resolveReferralSubscriptionWindow")}
    ${extractFunctionBlock("function isRangeActive")}
    ${extractFunctionBlock("function isReferralStillActive")}
    ${extractFunctionBlock("function isSubscriptionStatusActive")}
    ${extractFunctionBlock("function buildOwnerCandidateFromSubscription")}
    ${extractFunctionBlock("function compareCandidates")}
    ${extractFunctionBlock("function getStorageKey")}
    ${extractFunctionBlock("function isReferralDevPilotPhone")}
    ${extractFunctionBlock("function readStoredOwnerCandidate")}
    ${extractFunctionBlock("function writeStoredOwnerCandidate")}
    ${toRuntimeBlock("export function resolveReferralOwnerCandidate")}
    ${extractFunctionBlock("function resolveReferralOwnerCandidates")}
    ${toRuntimeBlock("export function hydrateReferralSubscriptionsWithNames")}
    ${toRuntimeBlock("export function resolveReferralShareOwnerCandidate")}
    ${toRuntimeBlock("export function resolveReferralRenewalOwnerCandidate")}
  `)}
  return {
    hydrateReferralSubscriptionsWithNames,
    resolveReferralRenewalOwnerCandidate,
    resolveReferralShareOwnerCandidate,
  };
`)() as {
  hydrateReferralSubscriptionsWithNames: (
    subscriptions: Array<Record<string, unknown>>,
    namesById: Record<string, string>,
  ) => Array<Record<string, unknown>>;
  resolveReferralShareOwnerCandidate: (
    subscriptions: Array<Record<string, unknown>>,
    ownerPhone: string,
    nowMs: number,
  ) => Record<string, unknown> | null;
  resolveReferralRenewalOwnerCandidate: (
    subscriptions: Array<Record<string, unknown>>,
    ownerPhone: string,
    nowMs: number,
  ) => Record<string, unknown> | null;
};
}

const runtime = buildRuntime(false);

function buildHarLikeSportSubscription() {
  return {
    subscriptionId: "97c895c6-0580-45ae-bec1-4c0f746d7fce",
    name: null,
    cost: 0,
    type: "GROUP",
    status: "ACTIVE",
    purchaseDate: "2026-05-22T08:53:29.71066",
    autoActivationDate: "2026-05-22",
    activationDate: "2026-05-22T21:00:02.986713",
    expirationDate: "2026-07-12",
    holdUntil: null,
    validityDays: 30,
    totalFreezeDays: 0,
    freezingDays: 0,
    freezeUsed: false,
    hasStudioLimitation: false,
    availableStudios: [],
    hasTypeLimitation: true,
    availableTypes: [
      { id: 839, name: "Падел Турнир" },
      { id: 1013, name: "Падел Турнир (Особый)" },
      { id: 1613, name: "Открытая игра" },
    ],
    hasDirectionLimitation: true,
    availableDirections: [
      { id: 2617, name: "Падел турнир от ПадлхАБ" },
      { id: 3284, name: "Турнир особый от ПадлхАБ" },
      { id: 4588, name: "Открытая игра на 4-ых человек." },
    ],
    hasDayLimitation: false,
    availableDaysOfWeek: [],
    hasTimeRangeLimitation: false,
    availableTimeRanges: [],
    variant: "BY_VISITS",
    visitsTotal: 30,
    visitsLeft: 10,
    timeLimitation: "NONE",
    minutes: 0,
    availableMinutes: 0,
    duration: "PT0S",
    availableDays: 23,
  };
}

test("HAR-like sport subscription without name does not build a share candidate by itself", () => {
  const candidate = runtime.resolveReferralShareOwnerCandidate(
    [buildHarLikeSportSubscription()],
    "79104303190",
    Date.parse("2026-06-18T09:00:00.000Z"),
  );

  assert.equal(candidate, null);
});

test("name lookup hydration restores share candidate for HAR-like sport subscription", () => {
  const hydrated = runtime.hydrateReferralSubscriptionsWithNames(
    [buildHarLikeSportSubscription()],
    {
      "97c895c6-0580-45ae-bec1-4c0f746d7fce": "Лето.Падел.Спорт",
    },
  );

  const candidate = runtime.resolveReferralShareOwnerCandidate(
    hydrated,
    "79104303190",
    Date.parse("2026-06-18T09:00:00.000Z"),
  );

  assert.ok(candidate);
  assert.equal(candidate?.planKey, "sport");
  assert.equal(candidate?.subscriptionName, "Лето.Падел.Спорт");
});

test("name lookup hydration does not overwrite an explicit subscription name", () => {
  const [hydrated] = runtime.hydrateReferralSubscriptionsWithNames(
    [
      {
        ...buildHarLikeSportSubscription(),
        name: "Лето.Падел.Дружба",
      },
    ],
    {
      "97c895c6-0580-45ae-bec1-4c0f746d7fce": "Лето.Падел.Спорт",
    },
  );

  assert.equal(hydrated?.name, "Лето.Падел.Дружба");
});

test("renewal candidate stays available when another later same-plan subscription exists", () => {
  const candidate = runtime.resolveReferralRenewalOwnerCandidate(
    [
      {
        subscriptionId: "summer-sport-june",
        name: "Лето.Падел.Спорт",
        status: "ACTIVE",
        expirationDate: "2026-06-18",
      },
      {
        subscriptionId: "summer-sport-july",
        name: "Лето.Падел.Спорт",
        status: "ACTIVE",
        expirationDate: "2026-06-21",
      },
    ],
    "79104303190",
    Date.parse("2026-06-18T09:00:00.000Z"),
  );

  assert.ok(candidate);
  assert.equal(candidate?.subscriptionId, "summer-sport-june");
  assert.equal(candidate?.subscriptionName, "Лето.Падел.Спорт");
});

test("renewal candidate accepts expired subscription during grace window", () => {
  const candidate = runtime.resolveReferralRenewalOwnerCandidate(
    [
      {
        subscriptionId: "summer-sport-expired",
        name: "Лето.Падел.Спорт",
        status: "EXPIRED",
        expirationDate: "2026-06-30",
      },
    ],
    "79104303190",
    Date.parse("2026-07-01T09:00:00.000Z"),
  );

  assert.ok(candidate);
  assert.equal(candidate?.subscriptionId, "summer-sport-expired");
  assert.equal(candidate?.planKey, "sport");
});

test("share candidate still ignores expired subscription during renewal grace window", () => {
  const candidate = runtime.resolveReferralShareOwnerCandidate(
    [
      {
        subscriptionId: "summer-sport-expired",
        name: "Лето.Падел.Спорт",
        status: "EXPIRED",
        expirationDate: "2026-06-30",
      },
    ],
    "79104303190",
    Date.parse("2026-07-01T09:00:00.000Z"),
  );

  assert.equal(candidate, null);
});

test("referral invite url uses inviteId and does not expose owner phone", () => {
  assert.match(source, /url\.searchParams\.set\("inviteId", normalizedInviteId\);/);
  assert.match(source, /url\.searchParams\.set\("mode", mode\);/);
  assert.match(
    source,
    /if \(IS_DEV_RELEASE_CHANNEL\) \{[\s\S]*url\.searchParams\.set\("ownerPhone", normalizedOwnerPhone\);[\s\S]*url\.searchParams\.set\("ownerSubscriptionId", normalizedOwnerSubscriptionId\);[\s\S]*url\.searchParams\.set\("channel", "dev"\);[\s\S]*\}/,
  );
});

test("dev referral invite url keeps legacy owner fallback beside inviteId", () => {
  assert.match(source, /const normalizedOwnerPhone = normalizeReferralPhone\(fallbackOwner\?\.ownerPhone\);/);
  assert.match(source, /const normalizedOwnerSubscriptionId = trimText\(fallbackOwner\?\.ownerSubscriptionId\);/);
  assert.match(source, /url\.searchParams\.set\("ownerPhone", normalizedOwnerPhone\);/);
  assert.match(source, /url\.searchParams\.set\("ownerSubscriptionId", normalizedOwnerSubscriptionId\);/);
  assert.match(source, /url\.searchParams\.set\("channel", "dev"\);/);
});

test("referral page retries status by legacy owner pair after inviteId 404", () => {
  const sourceText = fs.readFileSync("src/components/tournament-subscription/ReferralTournamentSubscriptionPage.tsx", "utf8");
  assert.match(sourceText, /result\.status === 404/);
  assert.match(sourceText, /setUseLegacyOwnerFallback\(true\)/);
  assert.match(sourceText, /inviteId:\s*null,\s*ownerPhone:\s*normalizedOwnerPhone,\s*ownerSubscriptionId:\s*normalizedOwnerSubscriptionId/s);
});

test("referral page no longer renders the top explanatory info blocks", () => {
  const sourceText = fs.readFileSync("src/components/tournament-subscription/ReferralTournamentSubscriptionPage.tsx", "utf8");
  assert.doesNotMatch(sourceText, /Реферальная ссылка:/);
  assert.doesNotMatch(sourceText, /По этой ссылке можно оформить по 1 абонементу каждого типа\./);
  assert.doesNotMatch(sourceText, /Продление владельцу откроется за сутки до окончания подписки/);
  assert.doesNotMatch(sourceText, /Ссылка на продление доступна за сутки до окончания подписки/);
});

test("referral page moves availability copy into the CTA and removes the separate counter block", () => {
  const sourceText = fs.readFileSync("src/components/tournament-subscription/ReferralTournamentSubscriptionPage.tsx", "utf8");
  assert.doesNotMatch(sourceText, /className="tournament-subscription-remaining-wrap"/);
  assert.match(sourceText, /Оформить подписку/);
  assert.match(sourceText, /Продлить подписку/);
  assert.match(sourceText, /\$\{remainingCount\} из \$\{totalLimit\}/);
  assert.doesNotMatch(sourceText, /доступно \$\{remainingCount\} из \$\{totalLimit\}/);
  assert.match(sourceText, /const ctaLabel = isBuying/);
});

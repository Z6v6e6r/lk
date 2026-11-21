import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  describeTournamentLevelGate,
  normalizeTournamentLevelDecision,
  resolveTournamentLevelGate,
  tournamentLevelLabelFromDecision,
} from "../../src/utils/tournamentLevelDecision.ts";

const server = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  policyVersion: "tournament-level-v2",
  mode: "ENFORCE",
  enforced: true,
  allowed: true,
  reasonCode: "LEVEL_ALLOWED",
  message: "Ваш уровень подходит для турнира.",
  ruleKind: "RANGE",
  baseRange: { min: 3, max: 3.5 },
  allowedGrades: null,
  levelTolerance: 0.2,
  effectiveRange: { min: 2.8, max: 3.7 },
  playerLevel: 3.31,
  ruleVersion: "tournament-level-v2:0123456789abcdef",
  ...overrides,
});

const gate = (payload: unknown, extra: Partial<Parameters<typeof resolveTournamentLevelGate>[0]> = {}) =>
  resolveTournamentLevelGate({
    decision: normalizeTournamentLevelDecision(payload),
    requestFailed: false,
    notFound: false,
    levelRestrictedHint: true,
    ...extra,
  });

test("shows base range, tolerance and effective bounds from the server", () => {
  const notice = describeTournamentLevelGate(gate(server()));
  assert.equal(notice?.rangeLine, "Уровень турнира: 3,00–3,50.");
  assert.equal(notice?.toleranceLine, "Допуск ±0,20: можно записаться с рейтингом 2,80–3,70.");
  assert.equal(notice?.tone, "ok");
});

test("player admitted only by the tolerance gets the tolerance message", () => {
  const state = gate(server({ reasonCode: "LEVEL_ALLOWED_WITH_TOLERANCE", playerLevel: 2.9 }));
  assert.equal(state.kind, "ALLOWED");
  assert.equal(describeTournamentLevelGate(state)?.statusLine, "Ваш уровень подходит с учётом допуска турнира.");
});

test("out-of-range player sees own level and bounds and is blocked before payment", () => {
  const state = gate(server({ allowed: false, reasonCode: "LEVEL_NOT_ALLOWED", playerLevel: 3.8 }));
  assert.equal(state.kind, "BLOCKED");
  assert.equal(
    describeTournamentLevelGate(state)?.statusLine,
    "Ваш уровень 3,80 вне допустимых границ 2,80–3,70. Запись на этот турнир недоступна.",
  );
});

test("missing level, unavailable check and invalid settings are separate states", () => {
  for (const [reasonCode, text] of [
    ["PLAYER_LEVEL_REQUIRED", /Уровень не определён/],
    ["PLAYER_LEVEL_UNKNOWN", /Не удалось подтвердить ваш уровень/],
    ["LEVEL_CHECK_UNAVAILABLE", /временно недоступна/],
    ["ACTIVITY_LEVEL_INVALID", /настроено некорректно/],
  ] as const) {
    const state = gate(server({ allowed: false, reasonCode, playerLevel: null }));
    assert.equal(state.kind, "BLOCKED", reasonCode);
    assert.match(describeTournamentLevelGate(state)?.statusLine ?? "", text);
  }
});

test("CUP unreachable for a restricted tournament blocks; unrestricted or 404 stays open", () => {
  assert.deepEqual(
    resolveTournamentLevelGate({ decision: null, requestFailed: true, notFound: false, levelRestrictedHint: true }),
    { kind: "BLOCKED", decision: null, reason: "LEVEL_CHECK_UNAVAILABLE" },
  );
  assert.equal(resolveTournamentLevelGate({ decision: null, requestFailed: true, notFound: false, levelRestrictedHint: false }).kind, "OPEN");
  assert.equal(resolveTournamentLevelGate({ decision: null, requestFailed: true, notFound: true, levelRestrictedHint: true }).kind, "OPEN");
});

test("legacy (not enforced) CUP changes nothing on screen", () => {
  const state = gate(server({ enforced: false, mode: "LEGACY", reasonCode: "LEVEL_GATE_LEGACY", allowed: true }));
  assert.equal(state.kind, "OPEN");
  assert.equal(describeTournamentLevelGate(state), null);
  assert.equal(tournamentLevelLabelFromDecision(state.decision), null);
});

test("malformed decisions never become allowed", () => {
  for (const payload of [null, {}, { allowed: "yes" }, server({ reasonCode: "SOMETHING" })]) {
    assert.equal(normalizeTournamentLevelDecision(payload), null);
  }
  assert.equal(gate({ allowed: true }, { requestFailed: true }).kind, "BLOCKED");
});

test("level row uses the server range instead of a wider local label", () => {
  assert.equal(tournamentLevelLabelFromDecision(normalizeTournamentLevelDecision(server())), "3,00–3,50 (с допуском 2,80–3,70)");
  assert.equal(
    tournamentLevelLabelFromDecision(normalizeTournamentLevelDecision(server({ levelTolerance: 0, effectiveRange: { min: 3, max: 3.5 } }))),
    "3,00–3,50",
  );
  assert.equal(
    tournamentLevelLabelFromDecision(normalizeTournamentLevelDecision(server({ ruleKind: "CATEGORIES", baseRange: null, allowedGrades: ["D+", "C"], levelTolerance: 0, effectiveRange: null }))),
    "D+, C",
  );
});

test("LK1 contains no admission formula and only consumes the server decision", () => {
  const source = fs.readFileSync("src/utils/tournamentLevelDecision.ts", "utf8");
  assert.doesNotMatch(source, /playerLevel\s*[<>]=?|[<>]=?\s*playerLevel|levelTolerance\s*[+-]|[+-]\s*levelTolerance/);
  const page = fs.readFileSync("src/components/tournament-signup/TournamentSignupPage.tsx", "utf8");
  assert.match(page, /apiFetchTournamentLevelDecision\(selectedId\)/, "fresh server decision before payment");
  assert.match(page, /levelGate\.kind !== "BLOCKED"/, "signup button follows the server decision");
});

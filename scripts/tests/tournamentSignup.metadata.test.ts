import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import type { TournamentSignupSummary } from "../../src/utils/tournamentSignupApi.ts";

const apiSource = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
const pageSource = fs.readFileSync("src/components/tournament-signup/TournamentSignupPage.tsx", "utf8");

function extractFunction(source: string, name: string) {
  const block = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, "m"))?.[0];
  assert.ok(block, `Missing function ${name}`);
  return stripTypeScriptTypes(block);
}

// Execute the production normalizers without loading browser/auth/payment modules.
const functions = [
  "isRecord", "pickString", "normalizeStringArray", "parseTournamentAccessLevel",
  "formatTournamentAccessLevel", "formatAccessLevelRange", "normalizeTournamentRatingLabel",
  "collectTournamentStateRecords", "buildTournamentLevelLabel", "buildTournamentGenderLabel",
];
const { buildTournamentLevelLabel, buildTournamentGenderLabel } = new Function(`
  ${functions.map((name) => extractFunction(apiSource, name)).join("\n")}
  return { buildTournamentLevelLabel, buildTournamentGenderLabel };
`)() as {
  buildTournamentLevelLabel: (value: unknown) => string | null;
  buildTournamentGenderLabel: (value: unknown) => string | null;
};

const toCard = new Function(
  "resolveTournamentCardPriceLabel",
  `const TOURNAMENT_SIGNUP_STATION_LABEL_BY_ID = {};
  ${["getTournamentStationLabel", "formatClock", "toCommunityTournamentCard"]
    .map((name) => extractFunction(pageSource, name)).join("\n")}
  return toCommunityTournamentCard;`,
)(() => null) as (summary: Partial<TournamentSignupSummary>) => {
  level?: string;
  ratingLabel?: string;
  genderLabel?: string;
};

test("CUP D1-D3 selection keeps both ends in the signup card", () => {
  const payload = { accessLevels: ["1", "1.25", "1.5", "1.75"], gender: "FEMALE" };
  const levelLabel = buildTournamentLevelLabel(payload);
  const genderLabel = buildTournamentGenderLabel(payload);
  assert.equal(levelLabel, "D1/D3");
  assert.equal(genderLabel, "Ж");
  const card = toCard({ levelLabel, genderLabel, studioName: "Сколково" });
  assert.equal(card.level, "D1/D3");
  assert.equal(card.ratingLabel, "D1/D3");
  assert.equal(card.genderLabel, "Ж");
  assert.match(apiSource, /levelLabel: buildTournamentLevelLabel\(value\)/);
  assert.match(apiSource, /genderLabel: buildTournamentGenderLabel\(value\)/);
});

test("numeric levels are sorted and comma decimals are accepted", () => {
  assert.equal(buildTournamentLevelLabel({ accessLevels: ["1,75", 1, "1.5"] }), "D1/D3");
});

test("levels within one division render a single label", () => {
  assert.equal(buildTournamentLevelLabel({ accessLevels: ["1", "1.25", "1.25"] }), "D1");
  assert.equal(buildTournamentLevelLabel({ accessLevels: ["1.5"] }), "D2");
  assert.equal(buildTournamentLevelLabel({ accessLevels: ["1.9"] }), "D4");
});

test("higher bands keep the same four CUP badge divisions", () => {
  for (const [value, expected] of [
    [2, "D+1"], [2.5, "D+2"], [2.75, "D+3"], [3, "C1"], [3.375, "C3"],
    [3.5, "C+1"], [4, "B1"], [4.525, "B3"], [4.7, "B+1"],
    [5.3, "B+3"], [5.5, "A1"], [6.1, "A3"], [6.3, "A4"],
  ] as const) {
    assert.equal(buildTournamentLevelLabel({ accessLevels: [value] }), expected, String(value));
  }
});

test("explicit and legacy labels remain available", () => {
  assert.equal(buildTournamentLevelLabel({ levelLabel: "D1 – D3" }), "D1–D3");
  assert.equal(buildTournamentLevelLabel({ accessLevels: ["D", "D+"] }), "D/D+");
  assert.equal(buildTournamentLevelLabel({ minRating: "D1", maxRating: "D3" }), "D1/D3");
  assert.equal(buildTournamentLevelLabel({ settings: { accessLevels: ["1", "1.75"] } }), "D1/D3");
});

test("missing and unknown levels do not turn into invented grades", () => {
  for (const value of [null, {}, { accessLevels: [] }, { accessLevels: [null, {}] }]) {
    assert.equal(buildTournamentLevelLabel(value), null);
  }
  for (const value of ["1bad", "0.5", "7"]) {
    assert.equal(buildTournamentLevelLabel({ accessLevels: [value] }), value);
  }
});

test("all CUP gender settings reach the card", () => {
  for (const [gender, expected] of [["FEMALE", "Ж"], ["MALE", "М"], ["MIXED", "М/Ж"]]) {
    const genderLabel = buildTournamentGenderLabel({ gender });
    assert.equal(genderLabel, expected);
    assert.equal(toCard({ genderLabel }).genderLabel, expected);
  }
});

test("nested gender and explicit labels work while absent gender keeps the card fallback", () => {
  assert.equal(buildTournamentGenderLabel({ publicTournament: { gender: "FEMALE" } }), "Ж");
  assert.equal(buildTournamentGenderLabel({ details: { settings: { gender: " female " } } }), "Ж");
  assert.equal(buildTournamentGenderLabel({ gender: "MALE", sourceTournament: { gender: "FEMALE" } }), "М");
  assert.equal(buildTournamentGenderLabel({ genderLabel: "Женщины" }), "Женщины");
  assert.equal(buildTournamentGenderLabel({ girlsOnly: true }), "Ж");
  for (const value of [null, {}, { gender: "UNKNOWN" }, { girlsOnly: false }]) {
    assert.equal(buildTournamentGenderLabel(value), null);
  }
  assert.equal(toCard({ genderLabel: null }).genderLabel, undefined);
});

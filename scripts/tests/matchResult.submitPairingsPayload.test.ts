import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

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

function transpileRuntime(code: string) {
  return ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}

const pairingRuntime = new Function(`
  ${transpileRuntime(`
    const DETAILS_TEAM_SLOTS_COUNT = 4;
    function normalizePhoneForGame(value: string | null | undefined): string | null {
      const digits = String(value || "").replace(/\\D/g, "");
      if (!digits) return null;
      if (digits.length === 10) return \`7\${digits}\`;
      if (digits.length === 11 && digits.startsWith("8")) return \`7\${digits.slice(1)}\`;
      return digits;
    }
    function normalizeMemberKey(value: unknown): string | null {
      if (typeof value !== "string") return null;
      const normalized = value.trim();
      return normalized || null;
    }
    function buildFallbackPadelPlayerMemberKey(player: {
      id?: string | null;
      phone?: string | null;
      name?: string | null;
    } | null | undefined): string | null {
      if (!player) return null;
      const id = (player.id || "").trim();
      if (id) return \`id:\${id}\`;
      const phone = normalizePhoneForGame(player.phone);
      if (phone) return \`phone:\${phone}\`;
      const name = (player.name || "").trim().toLowerCase();
      if (name) return \`name:\${name}\`;
      return null;
    }
    function getPadelPlayerMemberKey(player: {
      memberKey?: string | null;
      id?: string | null;
      phone?: string | null;
      name?: string | null;
    } | null | undefined): string {
      if (!player) return "";
      return (
        normalizeMemberKey(player.memberKey)
        || buildFallbackPadelPlayerMemberKey(player)
        || ""
      );
    }
    ${extractFunctionBlock("function cloneTeamSlots")}
    ${extractFunctionBlock("function buildMatchResultPairingSlotRef")}
    ${extractFunctionBlock("function buildMatchResultSetPairingsPayload")}
    ${extractFunctionBlock("function materializeCompletedMatchResultSetPairings")}
    ${extractFunctionBlock("function buildVisibleMatchResultSetPairings")}
    ${extractFunctionBlock("function buildMatchResultSubmitSetPairingsPayload")}
    ${extractFunctionBlock("function validateCompletedMatchResultSetPairings")}
  `)}
  return { buildMatchResultSubmitSetPairingsPayload, validateCompletedMatchResultSetPairings };
`)() as {
  buildMatchResultSubmitSetPairingsPayload: (
    pairings: Array<Array<Record<string, unknown> | null> | null>,
    completedSetCount: number,
    fallbackSlots: Array<Record<string, unknown> | null>,
  ) => Array<{ setIndex: number; teamSlots: Array<{ memberKey: string | null; name: string | null } | null> }>;
  validateCompletedMatchResultSetPairings: (
    pairings: Array<Array<Record<string, unknown> | null> | null>,
    completedSetCount: number,
    fallbackSlots: Array<Record<string, unknown> | null>,
  ) => string | null;
};

const buildSubmitPairingsPayload = pairingRuntime.buildMatchResultSubmitSetPairingsPayload;
const validateSubmitPairings = pairingRuntime.validateCompletedMatchResultSetPairings;

function player(id: string, name: string) {
  return { id, name };
}

test("submit payload uses the current visible lineup for trailing completed sets without explicit pairings", () => {
  const startPairing = [
    player("p1", "Андрей"),
    player("p2", "Максим"),
    player("p3", "Артем"),
    player("p4", "Никита"),
  ];
  const secondSetPairing = [
    player("p1", "Андрей"),
    player("p3", "Артем"),
    player("p2", "Максим"),
    player("p4", "Никита"),
  ];

  const payload = buildSubmitPairingsPayload(
    [
      startPairing,
      secondSetPairing,
      null,
      null,
    ],
    4,
    startPairing,
  );

  assert.deepEqual(
    payload.map((item) => item.teamSlots.map((slot) => slot?.memberKey ?? null)),
    [
      ["id:p1", "id:p2", "id:p3", "id:p4"],
      ["id:p1", "id:p3", "id:p2", "id:p4"],
      ["id:p1", "id:p2", "id:p3", "id:p4"],
      ["id:p1", "id:p2", "id:p3", "id:p4"],
    ],
  );
});

test("submit pairing validation accepts four distinct players", () => {
  const pairing = [
    player("p1", "Андрей"),
    player("p2", "Максим"),
    player("p3", "Артем"),
    player("p4", "Никита"),
  ];

  assert.equal(validateSubmitPairings([pairing], 1, pairing), null);
});

test("submit pairing validation rejects an incomplete explicit pairing", () => {
  const incomplete = [
    player("p1", "Андрей"),
    player("p2", "Максим"),
    player("p3", "Артем"),
    null,
  ];

  assert.match(validateSubmitPairings([incomplete], 1, incomplete) || "", /сета 1.*четырех игроков/i);
});

test("submit pairing validation rejects duplicate players", () => {
  const duplicate = [
    player("p1", "Андрей"),
    player("p2", "Максим"),
    player("p3", "Артем"),
    player("p1", "Андрей"),
  ];

  assert.match(validateSubmitPairings([duplicate], 1, duplicate) || "", /каждый игрок.*один раз/i);
});

test("submit pairing validation checks trailing completed sets materialized from fallback", () => {
  const complete = [
    player("p1", "Андрей"),
    player("p2", "Максим"),
    player("p3", "Артем"),
    player("p4", "Никита"),
  ];
  const incomplete = [complete[0], complete[1], complete[2], null];

  assert.equal(validateSubmitPairings([complete, null], 2, complete), null);
  assert.match(validateSubmitPairings([incomplete, null], 2, incomplete) || "", /сета 1/i);
});

test("submit pairing validation ignores empty pairings for uncompleted sets", () => {
  const complete = [
    player("p1", "Андрей"),
    player("p2", "Максим"),
    player("p3", "Артем"),
    player("p4", "Никита"),
  ];

  assert.equal(validateSubmitPairings([complete, null], 1, complete), null);
});

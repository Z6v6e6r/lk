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

const buildSubmitPairingsPayload = new Function(`
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
  `)}
  return buildMatchResultSubmitSetPairingsPayload;
`)() as (
  pairings: Array<Array<Record<string, unknown> | null> | null>,
  completedSetCount: number,
  fallbackSlots: Array<Record<string, unknown> | null>,
) => Array<{ setIndex: number; teamSlots: Array<{ memberKey: string | null; name: string | null } | null> }>;

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

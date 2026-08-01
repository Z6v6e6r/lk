import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");

function extractBlock(marker: string): string {
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

function toRunnableFunctionExpression(marker: string): string {
  const block = extractBlock(marker);
  return `(${block})`;
}

const runtimeSource = `
  const INACTIVE_GAME_MEMBERSHIP_STATUS_MARKERS = [
    "CANCEL",
    "DECLIN",
    "FAIL",
    "ERROR",
    "EXPIRE",
    "REFUND",
    "REJECT",
    "VOID",
    "CLOSE",
    "ARCHIVE",
    "LEFT",
    "REMOV",
  ];

  const toTrimmedString = (value) => {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const normalizePhoneForChat = (value) => {
    const digits = String(value || "").replace(/\\D/g, "");
    if (!digits) return null;
    if (digits.length === 10) return "7" + digits;
    if (digits.length === 11 && digits.startsWith("8")) return "7" + digits.slice(1);
    return digits;
  };

  const extractStringList = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => toTrimmedString(item))
      .filter(Boolean);
  };

  const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

  const isInactiveGameMembershipStatus = ${toRunnableFunctionExpression("function isInactiveGameMembershipStatus")};
  const normalizeGameIdentityId = ${toRunnableFunctionExpression("function normalizeGameIdentityId")};
  const normalizeGameIdentityPhone = ${toRunnableFunctionExpression("function normalizeGameIdentityPhone")};
  const gamePlayerMatchesIdentity = ${toRunnableFunctionExpression("function gamePlayerMatchesIdentity")};
  const recordListContainsIdentity = (value, identity, normalizer) => {
    if (!identity) return false;
    return extractStringList(value).some((item) => normalizer(item) === identity);
  };
  const splitPaymentItemMatchesIdentity = ${toRunnableFunctionExpression("function splitPaymentItemMatchesIdentity")};
  const getGameSplitPaymentMetadata = ${toRunnableFunctionExpression("function getGameSplitPaymentMetadata")};
  const hasActiveSplitPaymentIdentity = ${toRunnableFunctionExpression("function hasActiveSplitPaymentIdentity")};
  const isPadelGameRecordRelevantToIdentity = ${toRunnableFunctionExpression("function isPadelGameRecordRelevantToIdentity")};

  return isPadelGameRecordRelevantToIdentity;
`;

const transpiledRuntime = ts.transpileModule(runtimeSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
  },
}).outputText;

const buildRelevanceChecker = new Function(transpiledRuntime)() as (
  game: Record<string, unknown>,
  phone: string | null,
  clientId: string | null,
) => boolean;

function buildCancelledSplitGameFixture() {
  return {
    id: "pay_537fb4ed-0404-4fff-96f2-dd6e13da4c61",
    status: "PAID",
    organizer: {
      id: "8b6874de-027c-4dbd-a8fa-a57889a7c038",
      phone: "79264777769",
      name: "Светлана Григорьева",
    },
    participants: [
      {
        id: "8b6874de-027c-4dbd-a8fa-a57889a7c038",
        phone: "79264777769",
        name: "Светлана Григорьева",
        status: "CONFIRMED",
      },
    ],
    participantPhones: ["79264777769"],
    allRelatedPhones: ["79264777769", "79629042211"],
    allRelatedClientIds: [
      "8b6874de-027c-4dbd-a8fa-a57889a7c038",
      "3cf04c20-2377-4fa8-aed0-55385f301797",
    ],
    metadata: {
      organizerId: "8b6874de-027c-4dbd-a8fa-a57889a7c038",
      organizerPhoneNorm: "79264777769",
      bookingIds: [
        "66844055-5610-4312-b60c-826d44d77e15",
        "e7fe9326-9e0a-4770-8f3e-9ea7b927d6de",
      ],
      splitPayment: {
        enabled: true,
        organizerBookingId: "66844055-5610-4312-b60c-826d44d77e15",
        bookingIds: ["e7fe9326-9e0a-4770-8f3e-9ea7b927d6de"],
        payments: [
          {
            role: "ORGANIZER",
            status: "PAID",
            clientId: "8b6874de-027c-4dbd-a8fa-a57889a7c038",
            phoneNorm: "79264777769",
            bookingId: "66844055-5610-4312-b60c-826d44d77e15",
          },
          {
            role: "PARTICIPANT",
            status: "CANCELLED",
            clientId: "3cf04c20-2377-4fa8-aed0-55385f301797",
            phoneNorm: "79629042211",
            bookingId: "e7fe9326-9e0a-4770-8f3e-9ea7b927d6de",
            bookingIds: ["e7fe9326-9e0a-4770-8f3e-9ea7b927d6de"],
            cancelReason: "PLAYER_LEFT",
            cancelledAt: "2026-06-14T07:52:29.279Z",
            leftAt: "2026-06-14T07:52:29.279Z",
          },
        ],
      },
      leaveEvents: [
        {
          playerId: "3cf04c20-2377-4fa8-aed0-55385f301797",
          playerPhone: "79629042211",
          playerName: "Александр Полонянкин",
          leftAt: "2026-06-14T07:52:29.279Z",
          reason: "SELF",
          byId: "3cf04c20-2377-4fa8-aed0-55385f301797",
          byPhone: "79629042211",
          byName: "Александр Полонянкин",
        },
      ],
    },
  };
}

test("cancelled split participant is not relevant after leave event", () => {
  const game = buildCancelledSplitGameFixture();

  assert.equal(
    buildRelevanceChecker(game, "79629042211", "3cf04c20-2377-4fa8-aed0-55385f301797"),
    false,
  );
});

test("historical identity arrays alone never make a former participant relevant", () => {
  const game = buildCancelledSplitGameFixture();
  game.metadata.leaveEvents = [];
  game.allRelatedPhones = ["79264777769", "79629042211"];
  game.allRelatedClientIds = [
    "8b6874de-027c-4dbd-a8fa-a57889a7c038",
    "3cf04c20-2377-4fa8-aed0-55385f301797",
  ];

  assert.equal(
    buildRelevanceChecker(game, "79629042211", "3cf04c20-2377-4fa8-aed0-55385f301797"),
    false,
  );
});

test("organizer remains relevant after participant leaves split game", () => {
  const game = buildCancelledSplitGameFixture();

  assert.equal(
    buildRelevanceChecker(game, "79264777769", "8b6874de-027c-4dbd-a8fa-a57889a7c038"),
    true,
  );
});

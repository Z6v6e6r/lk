import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectResultRosterDrift,
  reconcileResultRosterSnapshot,
} from "../lib/resultRosterRepair.mjs";

const game = {
  id: "game-id-first",
  participants: [
    { clientId: "p1", phoneNorm: "79000000001", name: "P1" },
    { clientId: "p2", phoneNorm: null, name: "P2" },
    { clientId: "p3", phoneNorm: null, name: "P3" },
    { clientId: "p4", phoneNorm: null, name: "P4" },
  ],
  waitlist: [],
};

test("roster repair reconciles a partial phone-key snapshot by clientId", () => {
  const seedSnapshot = {
    version: 1,
    playerPool: [
      {
        memberKey: "phone:79000000001",
        clientId: "p1",
        phoneNorm: "79000000001",
        name: "P1",
      },
    ],
    initialTeamSlots: [
      { clientId: "p1" },
      { clientId: "p2" },
      { clientId: "p3" },
      { clientId: "p4" },
    ],
  };

  const before = inspectResultRosterDrift(game, seedSnapshot);
  assert.deepEqual(before.missingClientIds, ["p2", "p3", "p4"]);
  assert.equal(before.needsRepair, true);

  const result = reconcileResultRosterSnapshot({
    game,
    seedSnapshot,
    capturedAt: "2026-07-27T10:00:00.000Z",
  });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.snapshot.schemaVersion, 3);
  assert.equal(result.snapshot.members.length, 4);
  assert.equal(result.snapshot.members.filter((member) => member.clientId === "p1").length, 1);
  assert.equal(result.snapshot.members.find((member) => member.clientId === "p1").memberKey, "phone:79000000001");
  assert.deepEqual(result.snapshot.initialTeamMemberKeys, [
    "phone:79000000001",
    "id:p2",
    "id:p3",
    "id:p4",
  ]);

  const after = inspectResultRosterDrift(game, result.snapshot);
  assert.equal(after.needsRepair, false);
  assert.equal(
    inspectResultRosterDrift(game, { ...result.snapshot, schemaVersion: undefined, version: "result-roster-snapshot-v2" }).needsRepair,
    true,
  );
});

test("roster repair fails closed when one phone points to different client IDs", () => {
  const result = reconcileResultRosterSnapshot({
    game: {
      id: "game-conflict",
      participants: [
        { clientId: "p1", phoneNorm: "79000000001", name: "P1" },
        { clientId: "p2", phoneNorm: "79000000001", name: "P2" },
      ],
      waitlist: [],
    },
    seedSnapshot: null,
  });

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].code, "IDENTITY_CONFLICT");
});

test("roster repair skips legacy public members that cannot be mapped safely", () => {
  const result = reconcileResultRosterSnapshot({
    game,
    seedSnapshot: {
      version: "result-roster-snapshot-v1",
      members: [{ memberKey: "rm_unknown", name: "Unknown" }],
    },
  });

  assert.equal(result.conflicts[0].code, "UNRESOLVED_LEGACY_MEMBER");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSafeBackupDirectory,
  buildParticipantMembershipRepair,
} from "../repair_game_participant_membership.mjs";

const repairScriptSource = fs.readFileSync(
  fileURLToPath(new URL("../repair_game_participant_membership.mjs", import.meta.url)),
  "utf8",
);

function fixture() {
  return {
    id: "pay_game-1",
    updatedAt: "2026-08-01T09:00:00.000Z",
    organizer: { id: "org-1", phone: "79990000001", name: "Организатор" },
    participantPhones: ["79990000001", "79990000002"],
    waitlistPhones: ["79990000003"],
    allRelatedPhones: ["79990000001", "79990000002", "79990000003"],
    participants: [
      { id: "org-1", phone: "79990000001", name: "Организатор", source: "ORGANIZER" },
      { id: "player-1", phone: "79990000002", name: "Игрок", source: "INVITE_LINK" },
    ],
    waitlist: [
      { id: "player-2", phone: "79990000003", name: "Резерв", source: "INVITE_LINK" },
    ],
    metadata: {
      organizerId: "org-1",
      organizerPhoneNorm: "79990000001",
      splitPayment: {
        bookingIds: ["booking-org", "booking-player"],
        payments: [
          { clientId: "org-1", phoneNorm: "79990000001", bookingId: "booking-org", status: "PAID" },
          { clientId: "player-1", phoneNorm: "79990000002", bookingId: "booking-player", status: "PAID" },
        ],
      },
      leaveEvents: [],
    },
    audit: { version: 2, events: [] },
  };
}

test("exact participant repair removes only active membership and moves relation into history", () => {
  const game = fixture();
  const repair = buildParticipantMembershipRepair(
    game,
    { clientId: "player-1", phone: "+7 (999) 000-00-02", bookingId: "booking-player" },
    "2026-08-01T10:00:00.000Z",
  );
  const set = repair.update.$set;

  assert.deepEqual(set.participants.map((item) => item.id), ["org-1"]);
  assert.deepEqual(set.waitlist.map((item) => item.id), ["player-2"]);
  assert.deepEqual(set.participantPhones, ["79990000001"]);
  assert.deepEqual(set.allRelatedPhones, ["79990000001", "79990000003"]);
  assert.deepEqual(set.allRelatedClientIds, ["org-1", "player-2"]);
  assert.deepEqual(
    set.metadata.historicalRelatedPhones,
    ["79990000001", "79990000002", "79990000003"],
  );
  assert.equal(set.metadata.splitPayment.payments[1].status, "LEFT");
  assert.equal(set.metadata.leaveEvents.length, 1);
  assert.equal(repair.removedParticipants, 1);
  assert.equal(repair.removedWaitlist, 0);
  assert.equal(repair.matchedPayments, 1);
});

test("booking-only selector derives participant identity from the exact payment", () => {
  const repair = buildParticipantMembershipRepair(
    fixture(),
    { bookingId: "booking-player" },
    "2026-08-01T10:00:00.000Z",
  );

  assert.deepEqual(repair.update.$set.participants.map((item) => item.id), ["org-1"]);
  assert.deepEqual(repair.resolvedIds, ["player-1"]);
  assert.deepEqual(repair.resolvedPhones, ["79990000002"]);
});

test("repair refuses a selector that does not match one exact membership", () => {
  assert.throws(() => buildParticipantMembershipRepair(
    fixture(),
    { clientId: "player-1", phone: "79990000003" },
    "2026-08-01T10:00:00.000Z",
  ), /did not match/);
});

test("repair fails closed when one booking id resolves to distinct memberships", () => {
  const game = fixture();
  game.participants.push({ id: "player-2", phone: "79990000003", name: "Другой игрок" });
  game.metadata.splitPayment.payments.push({
    clientId: "player-2",
    phoneNorm: "79990000003",
    bookingId: "booking-player",
    status: "PAID",
  });

  assert.throws(() => buildParticipantMembershipRepair(
    game,
    { bookingId: "booking-player" },
    "2026-08-01T10:00:00.000Z",
  ), /ambiguous/);
});

test("repair fails closed when resolved identity would sweep another active payment", () => {
  const game = fixture();
  game.metadata.splitPayment.payments.push({
    clientId: "other-player",
    phoneNorm: "79990000002",
    bookingId: "other-booking",
    status: "PAID",
  });

  assert.throws(() => buildParticipantMembershipRepair(
    game,
    { bookingId: "booking-player" },
    "2026-08-01T10:00:00.000Z",
  ), /ambiguous/);
});

test("repair fails closed when the same participant has a newer active booking generation", () => {
  const game = fixture();
  game.metadata.splitPayment.payments.push({
    clientId: "player-1",
    phoneNorm: "79990000002",
    bookingId: "new-booking",
    status: "PAID",
  });

  assert.throws(() => buildParticipantMembershipRepair(
    game,
    { bookingId: "booking-player" },
    "2026-08-01T10:00:00.000Z",
  ), /active payment generations/);
});

test("repair preserves a rejoin when the selected old booking is already inactive", () => {
  const game = fixture();
  game.metadata.splitPayment.payments[1].status = "LEFT";
  game.metadata.splitPayment.payments.push({
    clientId: "player-1",
    phoneNorm: "79990000002",
    bookingId: "new-booking",
    status: "PAID",
  });

  assert.throws(() => buildParticipantMembershipRepair(
    game,
    { bookingId: "booking-player" },
    "2026-08-01T10:00:00.000Z",
  ), /active payment generations/);
});

test("repair refuses organizer removal", () => {
  assert.throws(() => buildParticipantMembershipRepair(
    fixture(),
    { bookingId: "booking-org" },
    "2026-08-01T10:00:00.000Z",
  ), /must not remove the organizer/);
});

test("rerun is a true no-op after one leave event and one audit event", () => {
  const first = buildParticipantMembershipRepair(
    fixture(),
    { bookingId: "booking-player" },
    "2026-08-01T10:00:00.000Z",
  );
  const afterFirst = {
    ...fixture(),
    ...first.update.$set,
  };
  const second = buildParticipantMembershipRepair(
    afterFirst,
    { bookingId: "booking-player" },
    "2026-08-01T10:05:00.000Z",
  );

  assert.equal(second.operationId, first.operationId);
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.update, null);
  assert.equal(second.removedParticipants, 0);
  assert.equal(second.matchedPayments, 0);
  assert.doesNotMatch(second.operationId, /79990000002/);
});

test("apply path backs up before one atomic game and chat transaction with mandatory read-back", () => {
  assert.match(repairScriptSource, /chatMessages:\s*chatMatches/);
  assert.match(repairScriptSource, /flag:\s*"wx"/);
  assert.match(repairScriptSource, /mode:\s*0o600/);
  assert.match(repairScriptSource, /session\.withTransaction/);
  assert.match(repairScriptSource, /writeConcern:\s*\{ w:\s*"majority" \}/);
  assert.match(repairScriptSource, /const gameReadback = await games\.findOne/);
  assert.match(repairScriptSource, /const postCommitGameReadback = await games\.findOne/);
  assert.match(repairScriptSource, /postCommitReadbackVerified = true/);
  assert.match(repairScriptSource, /await chats\.countDocuments\(chatFilter/);
  assert.match(repairScriptSource, /--mongo-uri is forbidden/);
  assert.match(repairScriptSource, /REPAIR_CLIENT_ID/);
  assert.doesNotMatch(repairScriptSource, /bookingId:\s*values\.get\("--booking-id"\)/);
  assert.doesNotMatch(repairScriptSource, /clientId:\s*values\.get\("--client-id"\)/);
  assert.doesNotMatch(repairScriptSource, /phone:\s*values\.get\("--phone"\)/);
  assert.match(repairScriptSource, /path must not contain symlinks/);
  assert.match(repairScriptSource, /recovery backup:/);
});

test("backup directory validation rejects symlinks and non-private directories", () => {
  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "lk-participant-repair-test-")),
  );
  fs.chmodSync(tempRoot, 0o700);
  try {
    const privateDirectory = path.join(tempRoot, "private-backup");
    assert.equal(assertSafeBackupDirectory(privateDirectory), privateDirectory);
    assert.equal(fs.statSync(privateDirectory).mode & 0o777, 0o700);

    const symlinkPath = path.join(tempRoot, "backup-link");
    fs.symlinkSync(privateDirectory, symlinkPath);
    assert.throws(() => assertSafeBackupDirectory(symlinkPath), /symlinks/);
    assert.throws(
      () => assertSafeBackupDirectory(path.join(symlinkPath, "nested")),
      /symlinks/,
    );

    const broadDirectory = path.join(tempRoot, "broad-backup");
    fs.mkdirSync(broadDirectory, { mode: 0o755 });
    assert.throws(() => assertSafeBackupDirectory(broadDirectory), /private/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

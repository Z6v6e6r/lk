import test from "node:test";
import assert from "node:assert/strict";
import type { PadelGamePlayer } from "../../src/utils/apiClient.ts";
import {
  excludePlayersAlreadyInRoster,
  playersShareRosterIdentity,
  reconcileRosterWithViva,
  type RosterSyncLeaveEvent,
} from "../../src/components/games/rosterSyncReconcile.ts";

function player(input: Partial<PadelGamePlayer> & { name: string }): PadelGamePlayer {
  return {
    id: input.id ?? null,
    name: input.name,
    phone: input.phone ?? null,
    photo: input.photo ?? null,
    rating: input.rating ?? null,
    ratingNumeric: input.ratingNumeric ?? null,
    source: input.source ?? "INVITE_LINK",
    status: input.status ?? "CONFIRMED",
  };
}

function leaveEvent(input: Partial<RosterSyncLeaveEvent>): RosterSyncLeaveEvent {
  return {
    playerId: input.playerId ?? null,
    playerPhone: input.playerPhone ?? null,
    playerName: input.playerName ?? null,
    leftAt: input.leftAt ?? "2026-05-31T15:00:00.000Z",
    reason: input.reason ?? "SELF",
    byId: input.byId ?? null,
    byPhone: input.byPhone ?? null,
    byName: input.byName ?? null,
  };
}

test("stale leave event does not hide a player present in Viva roster", () => {
  const organizer = player({ id: "org-1", name: "Организатор", phone: "79850000000", source: "ORGANIZER" });
  const svetlana = player({ id: "p-1", name: "Светлана", phone: "79626160919" });
  const sofya = player({ id: "p-2", name: "Софья", phone: "79854298828" });

  const result = reconcileRosterWithViva({
    sourceParticipants: [organizer],
    vivaParticipants: [organizer, svetlana, sofya],
    leaveEvents: [
      leaveEvent({ playerId: "p-1", playerPhone: "79626160919", playerName: "Светлана" }),
    ],
  });

  assert.equal(result.staleLeaveEventsRemoved, 1);
  assert.equal(result.nextLeaveEvents.length, 0);
  assert.deepEqual(
    result.mergedCandidates.map((item) => item.id),
    ["org-1", "p-1", "p-2"],
  );
});

test("admin-added player without phone is enriched from active Viva booking by id", () => {
  const organizer = player({ id: "org-1", name: "Организатор", phone: "79850000000", source: "ORGANIZER" });
  const adminAdded = player({ id: "p-admin", name: "Игрок из админки", phone: null, source: "ADMIN" });
  const vivaActive = player({ id: "p-admin", name: "Игрок из админки", phone: "79990000001", source: "VIVA" });

  const result = reconcileRosterWithViva({
    sourceParticipants: [organizer, adminAdded],
    vivaParticipants: [organizer, vivaActive],
    leaveEvents: [],
  });

  assert.equal(result.staleLeaveEventsRemoved, 0);
  assert.equal(result.filteredSourcePlayersCount, 0);
  assert.equal(result.mergedCandidates.length, 2);
  assert.deepEqual(
    result.mergedCandidates.map((item) => ({ id: item.id, phone: item.phone, source: item.source })),
    [
      { id: "org-1", phone: "79850000000", source: "ORGANIZER" },
      { id: "p-admin", phone: "79990000001", source: "ADMIN" },
    ],
  );
});

test("admin-added player missing from Viva roster is pruned from LK roster", () => {
  const organizer = player({ id: "org-1", name: "Организатор", phone: "79850000000", source: "ORGANIZER" });
  const staleAdmin = player({ id: "p-admin", name: "Анна", phone: "79990000001", source: "ADMIN" });
  const activePlayer = player({ id: "p-2", name: "Лев", phone: "79990000002", source: "ADMIN" });

  const result = reconcileRosterWithViva({
    sourceParticipants: [organizer, staleAdmin, activePlayer],
    vivaParticipants: [organizer, activePlayer],
    leaveEvents: [],
  });

  assert.equal(result.staleLeaveEventsRemoved, 0);
  assert.equal(result.filteredSourcePlayersCount, 0);
  assert.equal(result.staleSourcePlayersRemoved, 1);
  assert.deepEqual(
    result.mergedCandidates.map((item) => item.id),
    ["org-1", "p-2"],
  );
});

test("stale organizer-sourced player missing from Viva roster is pruned when canonical organizer differs", () => {
  const organizer = player({ id: "org-1", name: "Артур", phone: "79850000000", source: "ORGANIZER" });
  const staleFormerOrganizer = player({ id: "org-2", name: "Евгений", phone: "79990000001", source: "ORGANIZER" });
  const activePlayer = player({ id: "p-2", name: "Лев", phone: "79990000002", source: "ADMIN" });

  const result = reconcileRosterWithViva({
    sourceParticipants: [organizer, staleFormerOrganizer, activePlayer],
    vivaParticipants: [organizer, activePlayer],
    leaveEvents: [],
    organizerPlayer: organizer,
  });

  assert.equal(result.staleLeaveEventsRemoved, 0);
  assert.equal(result.filteredSourcePlayersCount, 0);
  assert.equal(result.staleSourcePlayersRemoved, 1);
  assert.deepEqual(
    result.mergedCandidates.map((item) => item.id),
    ["org-1", "p-2"],
  );
});

test("generic placeholder names with different viva client ids do not collapse into one player", () => {
  const organizer = player({ id: "org-1", name: "Организатор", phone: "79850000000", source: "ORGANIZER" });
  const staleMerged = player({ id: "p-spot-3", name: "Игрок", phone: "79990000004", source: "ADMIN" });
  const vivaSpot3 = player({ id: "p-spot-3", name: "Игрок", phone: "79990000003", source: "VIVA" });
  const vivaSpot4 = player({ id: "p-spot-4", name: "Игрок", phone: "79990000004", source: "VIVA" });

  const result = reconcileRosterWithViva({
    sourceParticipants: [organizer, staleMerged],
    vivaParticipants: [organizer, vivaSpot3, vivaSpot4],
    leaveEvents: [],
  });

  assert.equal(result.staleLeaveEventsRemoved, 0);
  assert.equal(result.filteredSourcePlayersCount, 0);
  assert.equal(result.mergedCandidates.length, 3);
  assert.deepEqual(
    result.mergedCandidates.map((item) => ({ id: item.id, phone: item.phone })),
    [
      { id: "org-1", phone: "79850000000" },
      { id: "p-spot-3", phone: "79990000003" },
      { id: "p-spot-4", phone: "79990000004" },
    ],
  );
});

test("real leave event still excludes player when player is absent in Viva roster", () => {
  const organizer = player({ id: "org-1", name: "Организатор", phone: "79850000000", source: "ORGANIZER" });
  const leftPlayer = player({ id: "p-left", name: "Ушедший игрок", phone: "79100000000" });
  const activePlayer = player({ id: "p-2", name: "Активный игрок", phone: "79854298828" });

  const result = reconcileRosterWithViva({
    sourceParticipants: [organizer, leftPlayer],
    vivaParticipants: [organizer, activePlayer],
    leaveEvents: [
      leaveEvent({ playerId: "p-left", playerPhone: "79100000000", playerName: "Ушедший игрок" }),
    ],
  });

  assert.equal(result.staleLeaveEventsRemoved, 0);
  assert.equal(result.nextLeaveEvents.length, 1);
  assert.equal(result.filteredSourcePlayersCount, 1);
  assert.deepEqual(
    result.mergedCandidates.map((item) => item.id),
    ["org-1", "p-2"],
  );
});

test("reconcile is idempotent when source and Viva rosters are already aligned", () => {
  const organizer = player({ id: "org-1", name: "Организатор", phone: "79850000000", source: "ORGANIZER" });
  const activePlayer = player({ id: "p-2", name: "Активный игрок", phone: "79854298828" });

  const first = reconcileRosterWithViva({
    sourceParticipants: [organizer, activePlayer],
    vivaParticipants: [organizer, activePlayer],
    leaveEvents: [],
  });
  const second = reconcileRosterWithViva({
    sourceParticipants: first.mergedCandidates,
    vivaParticipants: [organizer, activePlayer],
    leaveEvents: first.nextLeaveEvents,
  });

  assert.equal(first.staleLeaveEventsRemoved, 0);
  assert.equal(second.staleLeaveEventsRemoved, 0);
  assert.deepEqual(
    first.mergedCandidates.map((item) => item.id),
    ["org-1", "p-2"],
  );
  assert.deepEqual(
    second.mergedCandidates.map((item) => item.id),
    ["org-1", "p-2"],
  );
});

test("shared roster identity matches pending waitlist row to confirmed participant row", () => {
  const pendingWaitlistPlayer = player({
    id: "player-1",
    name: "Анна Смирнова",
    phone: null,
    status: "WAITLIST",
  });
  const confirmedParticipant = player({
    id: null,
    name: "Анна Смирнова",
    phone: "79990000001",
    status: "CONFIRMED",
  });

  assert.equal(playersShareRosterIdentity(pendingWaitlistPlayer, confirmedParticipant), true);
});

test("shared roster identity does not merge different strong identities only by same name", () => {
  const left = player({
    id: "player-1",
    name: "Анна Смирнова",
    phone: null,
  });
  const right = player({
    id: null,
    name: "Анна Смирнова",
    phone: "79990000002",
  });
  const conflict = player({
    id: "player-2",
    name: "Анна Смирнова",
    phone: null,
  });

  assert.equal(playersShareRosterIdentity(left, right), true);
  assert.equal(playersShareRosterIdentity(left, conflict), false);
});

test("waitlist dedupe removes player already promoted into participants", () => {
  const participants = [
    player({
      id: null,
      name: "Анна Смирнова",
      phone: "79990000001",
      status: "CONFIRMED",
    }),
  ];
  const waitlist = [
    player({
      id: "player-1",
      name: "Анна Смирнова",
      phone: null,
      status: "WAITLIST",
    }),
    player({
      id: "player-2",
      name: "Мария",
      phone: "79990000002",
      status: "WAITLIST",
    }),
  ];

  const filteredWaitlist = excludePlayersAlreadyInRoster(waitlist, participants);

  assert.deepEqual(
    filteredWaitlist.map((item) => item.name),
    ["Мария"],
  );
});

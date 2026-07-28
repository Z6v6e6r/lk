import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPairedTournamentStandingsGroups,
  parseAmericanoStandingsSortMode,
  resolveTournamentParticipantEntries,
  resolveTournamentStandingsSortModeValue,
} from "../../src/components/tournaments/tournamentManagerConfig.ts";

test("americano standings sort parser accepts total points aliases", () => {
  assert.equal(resolveTournamentStandingsSortModeValue("по очкам"), "total_points");
  assert.equal(resolveTournamentStandingsSortModeValue("total_points"), "total_points");
  assert.equal(resolveTournamentStandingsSortModeValue("point_diff"), "point_diff");

  assert.equal(
    parseAmericanoStandingsSortMode({ standingsSortMode: "по очкам" }),
    "total_points",
  );
  assert.equal(
    parseAmericanoStandingsSortMode({ winnerSortMode: "разница очков" }),
    "point_diff",
  );
  assert.equal(
    parseAmericanoStandingsSortMode({}, "point_diff"),
    "point_diff",
  );
});

test("tournament participants list does not auto-append organizer to odd roster", () => {
  const activeParticipants = [
    { id: "p1", name: "Игрок 1" },
    { id: "p2", name: "Игрок 2" },
    { id: "p3", name: "Игрок 3" },
  ];
  const organizerSlotParticipant = {
    id: "org-1",
    name: "Организатор",
    isOrganizerSlot: true,
  };

  const resolved = resolveTournamentParticipantEntries(activeParticipants, organizerSlotParticipant);

  assert.deepEqual(resolved, activeParticipants);
  assert.equal(resolved.some((participant) => participant.id === organizerSlotParticipant.id), false);
});

test("paired tournament table groups keep fixed pairs together in one standings row", () => {
  const rows = [
    { id: "p1", rank: 1, name: "Игрок 1" },
    { id: "p2", rank: 1, name: "Игрок 2" },
    { id: "p3", rank: 2, name: "Игрок 3" },
    { id: "p4", rank: 2, name: "Игрок 4" },
  ];

  const groups = buildPairedTournamentStandingsGroups(rows, [
    ["p1", "p2"],
    ["p3", "p4"],
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.rank), [1, 2]);
  assert.deepEqual(groups.map((group) => group.members.map((member) => member.id)), [
    ["p1", "p2"],
    ["p3", "p4"],
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildCompositeSlotCandidates } from "../../src/components/games/composite/compositeSlotBuilder.ts";
import type { GameTimeSlot } from "../../src/utils/apiClient.ts";

function buildSlot(overrides: Partial<GameTimeSlot> = {}): GameTimeSlot {
  return {
    id: "slot-1",
    roomId: "room-a",
    roomName: "Court A",
    date: "2026-06-20",
    time: "18:00",
    timeTo: "19:00",
    price: 2500,
    subServiceIds: ["sub-1"],
    durationMinutes: 60,
    ...overrides,
  };
}

test("composite slot builder returns a single 60-minute candidate without transition", () => {
  const candidates = buildCompositeSlotCandidates([
    buildSlot(),
  ]);

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    id: "single-60:slot-1",
    targetDurationMinutes: 60,
    patternKey: "single-60",
    patternLabel: "60 минут одной записью",
    fromTime: "18:00",
    toTime: "19:00",
    transitionCount: 0,
    segmentCount: 1,
    roomsLabel: "Court A",
    totalPrice: 2500,
    segments: [
      {
        slotId: "slot-1",
        roomId: "room-a",
        roomName: "Court A",
        fromTime: "18:00",
        toTime: "19:00",
        durationMinutes: 60,
        price: 2500,
        subServiceIds: ["sub-1"],
      },
    ],
  });
});

test("composite slot builder returns a 30+30 transition candidate across courts", () => {
  const candidates = buildCompositeSlotCandidates([
    buildSlot({
      id: "slot-1",
      roomId: "room-a",
      roomName: "Court A",
      time: "18:00",
      timeTo: "18:30",
      durationMinutes: 30,
      price: 1200,
    }),
    buildSlot({
      id: "slot-2",
      roomId: "room-b",
      roomName: "Court B",
      time: "18:30",
      timeTo: "19:00",
      durationMinutes: 30,
      price: 1300,
    }),
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.patternKey, "double-30-30");
  assert.equal(candidates[0]?.targetDurationMinutes, 60);
  assert.equal(candidates[0]?.transitionCount, 1);
  assert.equal(candidates[0]?.segmentCount, 2);
  assert.equal(candidates[0]?.roomsLabel, "Court A -> Court B");
  assert.equal(candidates[0]?.totalPrice, 2500);
  assert.deepEqual(candidates[0]?.segments.map((segment) => segment.slotId), ["slot-1", "slot-2"]);
});

test("composite slot builder returns a 60+30 candidate for 90 minutes", () => {
  const candidates = buildCompositeSlotCandidates([
    buildSlot({
      id: "slot-1",
      roomId: "room-a",
      roomName: "Court A",
      time: "18:00",
      timeTo: "19:00",
      durationMinutes: 60,
      price: 2400,
    }),
    buildSlot({
      id: "slot-2",
      roomId: "room-b",
      roomName: "Court B",
      time: "19:00",
      timeTo: "19:30",
      durationMinutes: 30,
      price: 1200,
    }),
  ]);

  assert.equal(candidates.length, 2);

  const ninetyMinuteCandidate = candidates.find((candidate) => candidate.patternKey === "double-60-30");
  assert.ok(ninetyMinuteCandidate);
  assert.equal(ninetyMinuteCandidate.targetDurationMinutes, 90);
  assert.equal(ninetyMinuteCandidate.fromTime, "18:00");
  assert.equal(ninetyMinuteCandidate.toTime, "19:30");
  assert.equal(ninetyMinuteCandidate.transitionCount, 1);
  assert.equal(ninetyMinuteCandidate.totalPrice, 3600);
});

test("composite slot builder filters out invalid and non-contiguous slots", () => {
  const candidates = buildCompositeSlotCandidates([
    buildSlot({
      id: "slot-gap-1",
      roomId: "room-a",
      roomName: "Court A",
      time: "18:00",
      timeTo: "18:30",
      durationMinutes: 30,
    }),
    buildSlot({
      id: "slot-gap-2",
      roomId: "room-b",
      roomName: "Court B",
      time: "19:00",
      timeTo: "19:30",
      durationMinutes: 30,
    }),
    buildSlot({
      id: "slot-invalid-time",
      roomId: "room-c",
      roomName: "Court C",
      time: "invalid",
      timeTo: "19:00",
      durationMinutes: 60,
    }),
    buildSlot({
      id: "slot-invalid-range",
      roomId: "room-d",
      roomName: "Court D",
      time: "20:00",
      timeTo: "19:30",
      durationMinutes: null,
      price: 1800,
    }),
  ]);

  assert.deepEqual(candidates, []);
});

test("composite slot builder sorts by start time and then by transition count", () => {
  const candidates = buildCompositeSlotCandidates([
    buildSlot({
      id: "late-single",
      roomId: "room-c",
      roomName: "Court C",
      time: "19:00",
      timeTo: "20:00",
      durationMinutes: 60,
      price: 2600,
    }),
    buildSlot({
      id: "early-first",
      roomId: "room-a",
      roomName: "Court A",
      time: "18:00",
      timeTo: "18:30",
      durationMinutes: 30,
      price: 1200,
    }),
    buildSlot({
      id: "early-second-same-room",
      roomId: "room-a",
      roomName: "Court A",
      time: "18:30",
      timeTo: "19:00",
      durationMinutes: 30,
      price: 1200,
    }),
    buildSlot({
      id: "early-second-other-room",
      roomId: "room-b",
      roomName: "Court B",
      time: "18:30",
      timeTo: "19:00",
      durationMinutes: 30,
      price: 1200,
    }),
  ]);

  assert.equal(candidates[0]?.id, "double-30-30:early-first>early-second-same-room");
  assert.equal(candidates[1]?.id, "double-30-30:early-first>early-second-other-room");
  assert.equal(candidates[0]?.transitionCount, 0);
  assert.equal(candidates[1]?.transitionCount, 1);
  assert.equal(candidates.at(-1)?.id, "single-60:late-single");
  assert.equal(candidates.at(-1)?.fromTime, "19:00");
});

import type { GameTimeSlot } from "../../../utils/apiClient";

export type CompositeTargetDuration = 60 | 90 | 120;

export interface CompositeSlotSegment {
  slotId: string;
  roomId: string;
  roomName: string;
  fromTime: string;
  toTime: string;
  durationMinutes: number;
  price: number | null;
  subServiceIds: string[];
}

export interface CompositeSlotCandidate {
  id: string;
  targetDurationMinutes: CompositeTargetDuration;
  patternKey: "single-60" | "double-30-30" | "double-60-30" | "double-30-60" | "double-60-60";
  patternLabel: string;
  fromTime: string;
  toTime: string;
  transitionCount: 0 | 1;
  segmentCount: 1 | 2;
  roomsLabel: string;
  totalPrice: number | null;
  segments: CompositeSlotSegment[];
}

interface NormalizedSlotSegment extends CompositeSlotSegment {
  fromMinutes: number;
  toMinutes: number;
}

type PatternDefinition = {
  targetDurationMinutes: CompositeTargetDuration;
  patternKey: CompositeSlotCandidate["patternKey"];
  patternLabel: string;
  durations: [number] | [number, number];
};

const PATTERNS: PatternDefinition[] = [
  {
    targetDurationMinutes: 60,
    patternKey: "single-60",
    patternLabel: "60 минут одной записью",
    durations: [60],
  },
  {
    targetDurationMinutes: 60,
    patternKey: "double-30-30",
    patternLabel: "60 минут как 30 + 30",
    durations: [30, 30],
  },
  {
    targetDurationMinutes: 90,
    patternKey: "double-60-30",
    patternLabel: "90 минут как 60 + 30",
    durations: [60, 30],
  },
  {
    targetDurationMinutes: 90,
    patternKey: "double-30-60",
    patternLabel: "90 минут как 30 + 60",
    durations: [30, 60],
  },
  {
    targetDurationMinutes: 120,
    patternKey: "double-60-60",
    patternLabel: "120 минут как 60 + 60",
    durations: [60, 60],
  },
];

function parseTimeToMinutes(value: string | null | undefined): number | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const [hoursRaw, minutesRaw] = normalized.split(":");
  const hours = Number.parseInt(hoursRaw || "", 10);
  const minutes = Number.parseInt(minutesRaw || "", 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatMinutes(totalMinutes: number): string {
  const normalized = ((totalMinutes % (24 * 60)) + (24 * 60)) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function inferDuration(slot: GameTimeSlot): number | null {
  if (typeof slot.durationMinutes === "number" && Number.isFinite(slot.durationMinutes) && slot.durationMinutes > 0) {
    return Math.round(slot.durationMinutes);
  }
  const fromMinutes = parseTimeToMinutes(slot.time);
  const toMinutes = parseTimeToMinutes(slot.timeTo);
  if (fromMinutes === null || toMinutes === null || toMinutes <= fromMinutes) return null;
  return toMinutes - fromMinutes;
}

function normalizeSlotSegment(slot: GameTimeSlot): NormalizedSlotSegment | null {
  const fromMinutes = parseTimeToMinutes(slot.time);
  const durationMinutes = inferDuration(slot);
  if (fromMinutes === null || durationMinutes === null) return null;
  const toMinutes = parseTimeToMinutes(slot.timeTo) ?? (fromMinutes + durationMinutes);
  const toTime = slot.timeTo?.trim() || formatMinutes(toMinutes);

  return {
    slotId: slot.id,
    roomId: slot.roomId,
    roomName: slot.roomName || "Корт",
    fromTime: slot.time,
    toTime,
    durationMinutes,
    price: typeof slot.price === "number" && Number.isFinite(slot.price) ? slot.price : null,
    subServiceIds: Array.isArray(slot.subServiceIds) ? slot.subServiceIds : [],
    fromMinutes,
    toMinutes,
  };
}

function sumPrice(segments: CompositeSlotSegment[]): number | null {
  if (segments.some((segment) => segment.price == null)) return null;
  return segments.reduce((total, segment) => total + (segment.price ?? 0), 0);
}

function buildRoomsLabel(segments: CompositeSlotSegment[]): string {
  if (segments.length === 0) return "Корт не определён";
  if (segments.length === 1) return segments[0].roomName;
  const [first, second] = segments;
  return first.roomId === second.roomId
    ? first.roomName
    : `${first.roomName} -> ${second.roomName}`;
}

export function buildCompositeSlotCandidates(slots: GameTimeSlot[]): CompositeSlotCandidate[] {
  const normalizedSlots = slots
    .map((slot) => normalizeSlotSegment(slot))
    .filter((slot): slot is NormalizedSlotSegment => slot !== null);

  const byDuration = new Map<number, NormalizedSlotSegment[]>();
  normalizedSlots.forEach((slot) => {
    const current = byDuration.get(slot.durationMinutes) ?? [];
    current.push(slot);
    byDuration.set(slot.durationMinutes, current);
  });

  const candidates = new Map<string, CompositeSlotCandidate>();

  PATTERNS.forEach((pattern) => {
    const [firstDuration, secondDuration] = pattern.durations;

    if (secondDuration == null) {
      (byDuration.get(firstDuration) ?? []).forEach((slot) => {
        const segments: CompositeSlotSegment[] = [{
          slotId: slot.slotId,
          roomId: slot.roomId,
          roomName: slot.roomName,
          fromTime: slot.fromTime,
          toTime: slot.toTime,
          durationMinutes: slot.durationMinutes,
          price: slot.price,
          subServiceIds: slot.subServiceIds,
        }];
        const candidate: CompositeSlotCandidate = {
          id: `${pattern.patternKey}:${slot.slotId}`,
          targetDurationMinutes: pattern.targetDurationMinutes,
          patternKey: pattern.patternKey,
          patternLabel: pattern.patternLabel,
          fromTime: slot.fromTime,
          toTime: slot.toTime,
          transitionCount: 0,
          segmentCount: 1,
          roomsLabel: buildRoomsLabel(segments),
          totalPrice: sumPrice(segments),
          segments,
        };
        candidates.set(candidate.id, candidate);
      });
      return;
    }

    const firstSlots = byDuration.get(firstDuration) ?? [];
    const secondSlots = byDuration.get(secondDuration) ?? [];

    firstSlots.forEach((firstSlot) => {
      secondSlots.forEach((secondSlot) => {
        if (firstSlot.slotId === secondSlot.slotId) return;
        if (firstSlot.toMinutes !== secondSlot.fromMinutes) return;

        const segments: CompositeSlotSegment[] = [
          {
            slotId: firstSlot.slotId,
            roomId: firstSlot.roomId,
            roomName: firstSlot.roomName,
            fromTime: firstSlot.fromTime,
            toTime: firstSlot.toTime,
            durationMinutes: firstSlot.durationMinutes,
            price: firstSlot.price,
            subServiceIds: firstSlot.subServiceIds,
          },
          {
            slotId: secondSlot.slotId,
            roomId: secondSlot.roomId,
            roomName: secondSlot.roomName,
            fromTime: secondSlot.fromTime,
            toTime: secondSlot.toTime,
            durationMinutes: secondSlot.durationMinutes,
            price: secondSlot.price,
            subServiceIds: secondSlot.subServiceIds,
          },
        ];
        const candidate: CompositeSlotCandidate = {
          id: `${pattern.patternKey}:${firstSlot.slotId}>${secondSlot.slotId}`,
          targetDurationMinutes: pattern.targetDurationMinutes,
          patternKey: pattern.patternKey,
          patternLabel: pattern.patternLabel,
          fromTime: firstSlot.fromTime,
          toTime: secondSlot.toTime,
          transitionCount: firstSlot.roomId === secondSlot.roomId ? 0 : 1,
          segmentCount: 2,
          roomsLabel: buildRoomsLabel(segments),
          totalPrice: sumPrice(segments),
          segments,
        };
        candidates.set(candidate.id, candidate);
      });
    });
  });

  return Array.from(candidates.values()).sort((left, right) => {
    if (left.fromTime !== right.fromTime) {
      return left.fromTime.localeCompare(right.fromTime, "ru");
    }
    if (left.transitionCount !== right.transitionCount) {
      return left.transitionCount - right.transitionCount;
    }
    if (left.segmentCount !== right.segmentCount) {
      return left.segmentCount - right.segmentCount;
    }
    const leftPrice = left.totalPrice ?? Number.MAX_SAFE_INTEGER;
    const rightPrice = right.totalPrice ?? Number.MAX_SAFE_INTEGER;
    if (leftPrice !== rightPrice) {
      return leftPrice - rightPrice;
    }
    return left.roomsLabel.localeCompare(right.roomsLabel, "ru");
  });
}

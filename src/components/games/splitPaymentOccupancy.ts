type UnknownRecord = Record<string, unknown>;

export interface SplitPaymentOccupancyParticipant {
  id?: unknown;
  phone?: unknown;
}

export interface SplitPaymentOccupancyResult {
  occupiedSlotsCount: number;
  reservedPaymentsBySpot: Map<number, UnknownRecord>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeComparableId(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  if (digits.length === 10) return `7${digits}`;
  return digits;
}

function normalizeStatus(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

export function isInactiveSplitPaymentReservationStatus(statusRaw: unknown): boolean {
  const status = normalizeStatus(statusRaw);
  if (!status) return false;
  return [
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
    "RELEASE",
  ].some((marker) => status.includes(marker));
}

function isWaitlistStatus(status: string): boolean {
  return status.includes("WAITLIST") || status === "RESERVE";
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function resolvePaymentDeadline(
  payment: UnknownRecord,
  splitPayment: UnknownRecord | null,
  paymentDeadlineMinutes: number,
): number | null {
  const explicitDeadlineTs = parseTimestamp(payment.deadlineAt)
    ?? parseTimestamp(payment.expiresAt)
    ?? parseTimestamp(splitPayment?.participantDeadlineAt)
    ?? parseTimestamp(splitPayment?.participantPaymentDeadlineAt);
  const createdAtTs = parseTimestamp(payment.createdAt) ?? parseTimestamp(payment.updatedAt);
  const createdAtDeadlineTs = createdAtTs == null
    ? null
    : createdAtTs + paymentDeadlineMinutes * 60 * 1000;
  if (explicitDeadlineTs != null) {
    return createdAtDeadlineTs == null
      ? explicitDeadlineTs
      : Math.min(explicitDeadlineTs, createdAtDeadlineTs);
  }
  return createdAtDeadlineTs;
}

function isPaymentHoldingSpot(
  payment: UnknownRecord,
  nowTs: number,
  splitPayment: UnknownRecord | null,
  paymentDeadlineMinutes: number,
): boolean {
  const status = normalizeStatus(payment.status);
  if (isInactiveSplitPaymentReservationStatus(status) || isWaitlistStatus(status)) return false;
  if (status === "PAYMENT_PENDING") {
    const deadlineTs = resolvePaymentDeadline(payment, splitPayment, paymentDeadlineMinutes);
    return deadlineTs == null || deadlineTs > nowTs;
  }
  return true;
}

function resolveIdentityKeys(value: UnknownRecord): string[] {
  const keys: string[] = [];
  const id = normalizeComparableId(value.id ?? value.clientId ?? value.playerId ?? value.userId);
  const phone = normalizePhone(value.phoneNorm ?? value.clientPhoneNorm ?? value.phone ?? value.clientPhone);
  if (id) keys.push(`id:${id}`);
  if (phone) keys.push(`phone:${phone}`);
  return keys;
}

function resolveReservationKeys(payment: UnknownRecord, index: number): string[] {
  const keys = resolveIdentityKeys(payment);
  const paymentRef = normalizeComparableId(payment.paymentRef);
  if (paymentRef) keys.push(`payment:${paymentRef}`);
  const bookingId = normalizeComparableId(payment.bookingId);
  if (bookingId) keys.push(`booking:${bookingId}`);
  if (Array.isArray(payment.bookingIds)) {
    payment.bookingIds.forEach((value) => {
      const normalized = normalizeComparableId(value);
      if (normalized) keys.push(`booking:${normalized}`);
    });
  }
  return Array.from(new Set(keys.length > 0 ? keys : [`row:${index}`]));
}

export function resolveSplitPaymentOccupancy(options: {
  participants: SplitPaymentOccupancyParticipant[];
  payments: unknown[];
  maxPlayers: number;
  nowTs?: number;
  splitPayment?: unknown;
  paymentDeadlineMinutes?: number;
}): SplitPaymentOccupancyResult {
  const maxPlayers = Number.isFinite(options.maxPlayers)
    ? Math.max(0, Math.floor(options.maxPlayers))
    : 0;
  const participants = Array.isArray(options.participants) ? options.participants : [];
  const nowTs = Number.isFinite(options.nowTs) ? Number(options.nowTs) : Date.now();
  const splitPayment = isRecord(options.splitPayment) ? options.splitPayment : null;
  const paymentDeadlineMinutes = Number.isFinite(options.paymentDeadlineMinutes)
    ? Math.max(1, Math.floor(Number(options.paymentDeadlineMinutes)))
    : 10;
  const participantKeys = new Set<string>();
  participants.forEach((participant) => {
    if (!isRecord(participant)) return;
    resolveIdentityKeys(participant).forEach((key) => participantKeys.add(key));
  });

  type ReservationCandidate = {
    identityKeys: string[];
    payment: UnknownRecord;
    reservationKeys: string[];
    spotIndex: number | null;
  };
  type ReservationGroup = {
    candidates: ReservationCandidate[];
    keys: Set<string>;
  };

  const reservedPaymentsBySpot = new Map<number, UnknownRecord>();
  const reservationGroups: ReservationGroup[] = [];

  (Array.isArray(options.payments) ? options.payments : []).forEach((rawPayment, index) => {
    if (!isRecord(rawPayment)) return;
    if (!isPaymentHoldingSpot(rawPayment, nowTs, splitPayment, paymentDeadlineMinutes)) return;

    const identityKeys = resolveIdentityKeys(rawPayment);
    const reservationKeys = resolveReservationKeys(rawPayment, index);
    const spotRaw = typeof rawPayment.spot === "number"
      ? rawPayment.spot
      : Number(String(rawPayment.spot || "").trim());
    const spotNumber = Number.isFinite(spotRaw) ? Math.floor(spotRaw) : null;
    const candidate: ReservationCandidate = {
      identityKeys,
      payment: rawPayment,
      reservationKeys,
      spotIndex: spotNumber != null && spotNumber >= 1 && spotNumber <= maxPlayers
        ? spotNumber - 1
        : null,
    };

    const matchingGroupIndexes = reservationGroups
      .map((group, groupIndex) => (
        reservationKeys.some((key) => group.keys.has(key)) ? groupIndex : -1
      ))
      .filter((groupIndex) => groupIndex >= 0);
    if (matchingGroupIndexes.length === 0) {
      reservationGroups.push({
        candidates: [candidate],
        keys: new Set(reservationKeys),
      });
      return;
    }

    const targetGroup = reservationGroups[matchingGroupIndexes[0]];
    targetGroup.candidates.push(candidate);
    reservationKeys.forEach((key) => targetGroup.keys.add(key));
    matchingGroupIndexes.slice(1).reverse().forEach((groupIndex) => {
      const mergedGroup = reservationGroups[groupIndex];
      mergedGroup.candidates.forEach((item) => targetGroup.candidates.push(item));
      mergedGroup.keys.forEach((key) => targetGroup.keys.add(key));
      reservationGroups.splice(groupIndex, 1);
    });
  });

  let activeReservationGroups = 0;
  reservationGroups.forEach((group) => {
    if (group.candidates.some((candidate) => (
      candidate.identityKeys.some((key) => participantKeys.has(key))
    ))) {
      return;
    }
    activeReservationGroups += 1;
    const candidateWithFreeSpot = group.candidates.find((candidate) => (
      candidate.spotIndex != null && !reservedPaymentsBySpot.has(candidate.spotIndex)
    ));
    if (candidateWithFreeSpot?.spotIndex != null) {
      reservedPaymentsBySpot.set(candidateWithFreeSpot.spotIndex, candidateWithFreeSpot.payment);
    }
  });

  return {
    occupiedSlotsCount: Math.min(
      maxPlayers,
      participants.length + activeReservationGroups,
    ),
    reservedPaymentsBySpot,
  };
}

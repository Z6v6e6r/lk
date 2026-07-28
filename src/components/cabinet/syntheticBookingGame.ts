import type { Booking, PadelGamePlayer, PadelGameRecord } from "../../utils/apiClient";

export const CABINET_BOOKING_SYNTHETIC_SOURCE = "cabinet_booking_synthetic";

function extractDatePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const matched = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return matched ?? null;
}

function extractTimePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const matched = value.match(/T?(\d{2}:\d{2})/)?.[1];
  return matched ?? null;
}

function resolveDurationMinutes(booking: Booking): number | null {
  const fromTs = booking.exercise?.timeFrom ? Date.parse(booking.exercise.timeFrom) : NaN;
  const toTs = booking.exercise?.timeTo ? Date.parse(booking.exercise.timeTo) : NaN;
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return null;
  return Math.round((toTs - fromTs) / 60000);
}

export function isSyntheticCabinetBookingGame(game: PadelGameRecord | null | undefined): boolean {
  if (!game?.metadata || typeof game.metadata !== "object" || Array.isArray(game.metadata)) return false;
  return game.metadata.source === CABINET_BOOKING_SYNTHETIC_SOURCE;
}

export function buildSyntheticCabinetGameFromBooking(
  booking: Booking,
  options: {
    paid?: boolean | null;
    currentUserPlayer?: PadelGamePlayer | null;
  } = {},
): PadelGameRecord | null {
  const exercise = booking.exercise;
  if (!exercise?.id || !exercise.studio?.id || !exercise.room?.id) return null;

  const date = extractDatePart(exercise.timeFrom);
  const timeFrom = extractTimePart(exercise.timeFrom);
  const timeTo = extractTimePart(exercise.timeTo);
  if (!date || !timeFrom || !timeTo) return null;

  const paid = options.paid ?? null;
  const currentUserPlayer = options.currentUserPlayer
    ? {
        ...options.currentUserPlayer,
        status: options.currentUserPlayer.status ?? "CONFIRMED",
      }
    : null;
  const amount = Number.isFinite(booking.cost) ? Math.max(0, Math.round(booking.cost / 100)) : null;
  const maxPlayers = Number.isFinite(exercise.maxClientsCount) && exercise.maxClientsCount > 0
    ? Math.max(1, Math.round(exercise.maxClientsCount))
    : 4;

  return {
    id: `viva_${exercise.id}`,
    inviteUrl: null,
    status: booking.isCancelled ? "CANCELLED" : paid === false ? "PAYMENT_PENDING" : "PAID",
    organizer: null,
    settings: {
      ratingGame: true,
      minRating: null,
      maxRating: null,
      isPrivate: false,
      payMode: "self",
    },
    participants: currentUserPlayer ? [currentUserPlayer] : [],
    waitlist: [],
    invite: {
      waitlistEnabled: true,
      maxPlayers,
    },
    chatUrl: null,
    metadata: {
      source: CABINET_BOOKING_SYNTHETIC_SOURCE,
      synthetic: true,
      bookingId: booking.id,
      bookingIds: [booking.id],
      exerciseId: exercise.id,
      vivaExerciseId: exercise.id,
      bookingPaymentType: booking.paymentType,
      visitConfirmed: booking.visitConfirmed,
    },
    booking: {
      studioName: exercise.studio.name ?? null,
      roomName: exercise.room.name ?? null,
      date,
      timeFrom,
      timeTo,
      durationMinutes: resolveDurationMinutes(booking),
      studioId: String(exercise.studio.id),
      roomId: String(exercise.room.id),
      bookingId: booking.id,
      bookingIds: [booking.id],
      exerciseId: exercise.id,
      vivaExerciseId: exercise.id,
      subServiceIds: [],
    },
    payment: {
      amount,
      paymentUrl: booking.transactionStatus?.cardPaymentStatus?.paymentUrl ?? null,
      paid,
    },
  };
}

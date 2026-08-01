import { apiFetchBookings } from "./apiClient";
import {
  recoverGameExerciseIdWithFetcher,
  type GameExerciseIdRecoveryResult,
} from "./paymentSyncBookingResolution";

export async function recoverGameExerciseId(options: {
  exerciseIds?: Array<string | null | undefined>;
  bookingIds: string[];
}): Promise<GameExerciseIdRecoveryResult> {
  return recoverGameExerciseIdWithFetcher({
    ...options,
    fetchBookings: apiFetchBookings,
  });
}

import {
  apiCreatePadelGameDraft,
  apiCreatePadelGameRecord,
  apiFetchPadelGameByPaymentRef,
  apiFetchPadelGamesByBookingReferences,
  type PadelGameRecordPayload,
} from "./apiClient";
import {
  persistServerGameDraftWithReadback,
  persistRecoveredSubscriptionGameWithReadback,
  type ServerGameDraftApiResult,
  type ServerGameDraftPersistenceResult,
  type SplitSurchargeDraftBinding,
} from "./serverGameDraftPersistencePolicy";

export {
  isExactServerGameDraftReadback,
  type ServerGameDraftPersistenceDependencies,
  type ServerGameDraftPersistenceResult,
} from "./serverGameDraftPersistencePolicy";

async function lookupGameByBothReferences(paymentRef: string, bookingIds: string[]): Promise<ServerGameDraftApiResult> {
  const { data, status, error } = await apiFetchPadelGamesByBookingReferences(paymentRef, bookingIds);
  if (error || status !== 200 || !data?.complete || data.games.length !== data.total || data.games.length > 1) {
    return { data: null, status, error: error ?? { message: "Не удалось однозначно проверить исходную игру" } };
  }
  const record = data.games[0] ?? null;
  return { data: record, status, error: null, ...(record ? {} : { missing: true }) };
}

export async function persistServerGameDraftBeforeRedirect(
  paymentRefRaw: string,
  payload: PadelGameRecordPayload,
  bookingIdsRaw: string[] = [],
  splitSurcharge?: SplitSurchargeDraftBinding,
): Promise<ServerGameDraftPersistenceResult> {
  return persistServerGameDraftWithReadback(paymentRefRaw, payload, bookingIdsRaw, {
    createDraft: apiCreatePadelGameDraft,
    lookupDraft: splitSurcharge
      ? lookupGameByBothReferences
      : (paymentRef, bookingIds) => apiFetchPadelGameByPaymentRef(paymentRef, bookingIds, { mode: "combined" }),
  }, splitSurcharge);
}


export function persistRecoveredSubscriptionGame(
  payload: PadelGameRecordPayload,
  existingCardOnly: boolean,
  canWrite: () => boolean,
) {
  return persistRecoveredSubscriptionGameWithReadback(payload, existingCardOnly, canWrite, {
    createGame: apiCreatePadelGameRecord,
    lookupDraft: lookupGameByBothReferences,
  });
}

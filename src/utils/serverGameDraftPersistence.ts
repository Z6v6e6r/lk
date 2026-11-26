import {
  apiCreatePadelGameDraft,
  apiFetchPadelGameByPaymentRef,
  type PadelGameRecordPayload,
} from "./apiClient";
import {
  isExactWholeCourtDraftReadback,
  persistServerGameDraftWithReadback,
  type ServerGameDraftPersistenceResult,
} from "./serverGameDraftPersistencePolicy";

export {
  isExactServerGameDraftReadback,
  type ServerGameDraftPersistenceDependencies,
  type ServerGameDraftPersistenceResult,
} from "./serverGameDraftPersistencePolicy";

export { isExactWholeCourtDraftReadback };

export async function readWholeCourtDraftForCheckout(
  paymentRef: string,
  bookingIds: string[],
  payload: PadelGameRecordPayload,
) {
  const result = await apiFetchPadelGameByPaymentRef(paymentRef, bookingIds, { mode: "combined" });
  return isExactWholeCourtDraftReadback(result.data, payload, paymentRef, bookingIds) ? result.data : null;
}

export async function persistServerGameDraftBeforeRedirect(
  paymentRefRaw: string,
  payload: PadelGameRecordPayload,
  bookingIdsRaw: string[] = [],
): Promise<ServerGameDraftPersistenceResult> {
  return persistServerGameDraftWithReadback(paymentRefRaw, payload, bookingIdsRaw, {
    createDraft: apiCreatePadelGameDraft,
    lookupDraft: (paymentRef, bookingIds) => apiFetchPadelGameByPaymentRef(
      paymentRef,
      bookingIds,
      { mode: "combined" },
    ),
  });
}

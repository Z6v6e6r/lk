import {
  apiCreatePadelGameDraft,
  apiFetchPadelGameByPaymentRef,
  type PadelGameRecordPayload,
} from "./apiClient";
import {
  persistServerGameDraftWithReadback,
  type ServerGameDraftPersistenceResult,
} from "./serverGameDraftPersistencePolicy";

export {
  isExactServerGameDraftReadback,
  type ServerGameDraftPersistenceDependencies,
  type ServerGameDraftPersistenceResult,
} from "./serverGameDraftPersistencePolicy";

export async function persistServerGameDraftBeforeRedirect(
  paymentRefRaw: string,
  payload: PadelGameRecordPayload,
  bookingIdsRaw: string[] = [],
): Promise<ServerGameDraftPersistenceResult> {
  return persistServerGameDraftWithReadback(paymentRefRaw, payload, bookingIdsRaw, {
    createDraft: apiCreatePadelGameDraft,
    lookupDraft: apiFetchPadelGameByPaymentRef,
  });
}

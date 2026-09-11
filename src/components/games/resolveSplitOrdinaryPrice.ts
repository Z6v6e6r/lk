import { apiFetchMasterServicePrice } from "../../utils/apiClient";
import {
  buildSplitOrdinaryPrice,
  resolveSplitOrdinaryPriceContract,
  type SplitOrdinaryPrice,
  type SplitOrdinaryPriceParams,
} from "./splitOrdinaryPricing";

export type SplitOrdinaryPriceOutcome =
  | { status: "resolved"; price: SplitOrdinaryPrice }
  | { status: "failed" }
  | { status: "unavailable" };

/**
 * Display-only lookup of the ordinary (non-campaign) participant share from the
 * exact Viva court price for the stored station, room, date/time, master service
 * and sub-services. The nominal transaction product cost and any browser-supplied
 * amount are never pricing authority: the server re-resolves the same exact price
 * before it charges a participant.
 *
 * `unavailable` means the lookup could not run at all (incomplete contract or no
 * session), so callers must not fall back to a stored nominal amount; `failed`
 * means it ran and came back without a usable price.
 */
export async function resolveSplitOrdinaryPrice(
  params: SplitOrdinaryPriceParams,
): Promise<SplitOrdinaryPriceOutcome> {
  const contract = resolveSplitOrdinaryPriceContract(params);
  if (!contract) return { status: "unavailable" };

  const result = await apiFetchMasterServicePrice({
    date: contract.date,
    fromTime: contract.fromTime,
    toTime: contract.toTime,
    studioId: contract.studioId,
    roomId: contract.roomId,
    masterServiceId: contract.masterServiceId,
    subServiceIds: contract.subServiceIds,
  });
  if (result.error && result.data == null) {
    const status = Number(result.error.status);
    // Without a session the request never leaves the browser; an explicit refusal
    // is equally not a price. Only a real lookup may unlock the legacy fallback.
    if (status === 401 || status === 403) return { status: "unavailable" };
    return { status: "failed" };
  }
  const price = buildSplitOrdinaryPrice(result.data, contract.shareCount);
  return price ? { status: "resolved", price } : { status: "failed" };
}

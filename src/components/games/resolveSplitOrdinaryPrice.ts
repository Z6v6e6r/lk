import { apiFetchMasterServicePrice } from "../../utils/apiClient";
import {
  buildSplitOrdinaryPrice,
  resolveSplitOrdinaryPriceContract,
  type SplitOrdinaryPrice,
  type SplitOrdinaryPriceParams,
} from "./splitOrdinaryPricing";

/**
 * Display-only lookup of the ordinary (non-campaign) participant share from the
 * exact Viva court price for the stored station, room, date/time, master service
 * and sub-services. The nominal transaction product cost and any browser-supplied
 * amount are never pricing authority: the server re-resolves the same exact price
 * before it charges a participant.
 */
export async function resolveSplitOrdinaryPrice(
  params: SplitOrdinaryPriceParams,
): Promise<SplitOrdinaryPrice | null> {
  const contract = resolveSplitOrdinaryPriceContract(params);
  if (!contract) return null;

  const result = await apiFetchMasterServicePrice({
    date: contract.date,
    fromTime: contract.fromTime,
    toTime: contract.toTime,
    studioId: contract.studioId,
    roomId: contract.roomId,
    masterServiceId: contract.masterServiceId,
    subServiceIds: contract.subServiceIds,
  });
  if (result.error && result.data == null) return null;
  return buildSplitOrdinaryPrice(result.data, contract.shareCount);
}

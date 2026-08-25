export interface ReferralAttribution {
  referralToken: string;
  referralVisitId: string;
}

const REFERRAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;
const REFERRAL_VISIT_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export function normalizeReferralAttribution(
  tokenValue: unknown,
  visitIdValue: unknown,
): ReferralAttribution | null {
  const referralToken = String(tokenValue ?? "").trim();
  const referralVisitId = String(visitIdValue ?? "").trim();
  if (!REFERRAL_TOKEN_PATTERN.test(referralToken)) return null;
  if (!REFERRAL_VISIT_ID_PATTERN.test(referralVisitId)) return null;
  return { referralToken, referralVisitId };
}

export function readReferralAttribution(
  search = typeof window === "undefined" ? "" : window.location.search,
): ReferralAttribution | null {
  const params = new URLSearchParams(search);
  return normalizeReferralAttribution(params.get("ref"), params.get("ref_visit"));
}

export interface SubscriptionUsageTestCredentials {
  offerId: string;
  token: string;
}

export function isHostedSubscriptionUsageTestRoute(
  pathname: string,
  search: string,
  isDevReleaseChannel: boolean,
): boolean {
  if (!isDevReleaseChannel || pathname.replace(/\/+$/, "") !== "/lk_dev") return false;
  return new URLSearchParams(search).get("subscriptionTest") === "1";
}

export function readSubscriptionUsageTestCredentials(
  hash: string,
): SubscriptionUsageTestCredentials | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const offerId = params.get("offerId")?.trim() || "";
  const token = params.get("token")?.trim() || "";
  if (offerId.length < 3 || token.length < 32) return null;
  return { offerId, token };
}

export function subscriptionUsageTestApiPath(
  offerId: string,
  operation: "snapshot" | "quote" | "resolved-quote",
): string {
  const encodedOfferId = encodeURIComponent(offerId);
  const root = `/v1/subscription-test/offers/${encodedOfferId}/usage-scenarios`;
  if (operation === "quote") return `${root}/quote`;
  if (operation === "resolved-quote") return `${root}/resolved-quote`;
  return root;
}

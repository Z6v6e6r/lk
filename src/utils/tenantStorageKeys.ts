/** Browser state partitioning only; provider/backend still authorize requests. */
export function tenantStorageKeys(tenantKey: string) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantKey)) throw new Error("Invalid tenant key");
  const primary = tenantKey === "iSkq6G";
  const prefix = primary ? "padlhub" : `lk_${tenantKey}`;
  return {
    primary,
    accessCookie: primary ? "padlhubAuthToken" : `${prefix}_auth_token`,
    refreshCookie: primary ? "padlhubRefreshToken" : `${prefix}_refresh_token`,
    accessStorage: `${prefix}_auth_token_v1`,
    refreshStorage: `${prefix}_refresh_token_v1`,
    oauthStorage: `${prefix}_viva_oauth_pending_v1`,
    subscriptionStorage: `${prefix}_subscription_snapshot_v1`,
    subscriptionGlobal: primary ? "__padlhubSubscriptionSnapshotV1" : `__lk_${tenantKey}_subscriptionSnapshotV1`,
  };
}

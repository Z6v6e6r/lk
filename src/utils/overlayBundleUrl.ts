const PROD_LK_ASSET_BASE_URL = "https://padlhub.su/lk";
const DEV_LK_ASSET_BASE_URL = "https://lk-reserve.89-108-64-209.sslip.io/lk";

export function resolveReleaseChannelUrl(
  configuredUrl: string | undefined,
  productionUrl: string,
  devUrl: string,
  isDevReleaseChannel: boolean,
): string {
  const normalizedConfiguredUrl = configuredUrl?.trim();
  if (normalizedConfiguredUrl) return normalizedConfiguredUrl;

  return isDevReleaseChannel ? devUrl : productionUrl;
}

export function resolveLkAssetBaseUrl(
  configuredUrl: string | undefined,
  isDevReleaseChannel: boolean,
): string {
  return resolveReleaseChannelUrl(
    configuredUrl,
    PROD_LK_ASSET_BASE_URL,
    DEV_LK_ASSET_BASE_URL,
    isDevReleaseChannel,
  );
}

export function resolveOverlayBundleUrl(
  configuredUrl: string | undefined,
  bundleName: string,
  isDevReleaseChannel: boolean,
): string {
  const normalizedConfiguredUrl = configuredUrl?.trim();
  if (normalizedConfiguredUrl) return normalizedConfiguredUrl;

  const baseUrl = resolveLkAssetBaseUrl(undefined, isDevReleaseChannel);
  const fileName = `${bundleName}${isDevReleaseChannel ? "-dev" : ""}.js`;
  return `${baseUrl}/${fileName}`;
}

const PROD_LK_ASSET_BASE_URL = "https://padlhub.su/lk";
const DEV_LK_ASSET_BASE_URL = "https://lk-reserve.89-108-64-209.sslip.io/lk";

export function resolveOverlayBundleUrl(
  configuredUrl: string | undefined,
  bundleName: string,
  isDevReleaseChannel: boolean,
): string {
  const normalizedConfiguredUrl = configuredUrl?.trim();
  if (normalizedConfiguredUrl) return normalizedConfiguredUrl;

  const baseUrl = isDevReleaseChannel ? DEV_LK_ASSET_BASE_URL : PROD_LK_ASSET_BASE_URL;
  const fileName = `${bundleName}${isDevReleaseChannel ? "-dev" : ""}.js`;
  return `${baseUrl}/${fileName}`;
}

import {
  resolveLkAssetBaseUrl,
  resolveOverlayBundleUrl,
  resolveReleaseChannelUrl,
} from "../utils/overlayBundleUrl";

const PROD_SERV2_URL = "https://padlhub.su/seliger";
const DEV_SERV2_URL = "https://lk-reserve.89-108-64-209.sslip.io/seliger";
const PROD_CABINET_URL = "https://padlhub.ru/lk_new";
const DEV_CABINET_URL = "https://padlhub.ru/lk_dev";

export const IS_DEV_RELEASE_CHANNEL = import.meta.env.MODE === "dev";
const ACTIVE_LK_ASSET_BASE_URL = resolveLkAssetBaseUrl(undefined, IS_DEV_RELEASE_CHANNEL);

export const API_BASE = resolveReleaseChannelUrl(
  import.meta.env.VITE_API_BASE as string | undefined,
  "https://api.vivacrm.ru",
  "https://api.vivacrm.ru",
  IS_DEV_RELEASE_CHANNEL,
);
export const KEYCLOAK_BASE = resolveReleaseChannelUrl(
  import.meta.env.VITE_KEYCLOAK_BASE as string | undefined,
  "https://kc.vivacrm.ru",
  "https://kc.vivacrm.ru",
  IS_DEV_RELEASE_CHANNEL,
);
export const TENANT_KEY =
  (import.meta.env.VITE_TENANT_KEY as string | undefined)?.trim() || "iSkq6G";
export const SERV2 = resolveReleaseChannelUrl(
  import.meta.env.VITE_SERV2 as string | undefined,
  PROD_SERV2_URL,
  DEV_SERV2_URL,
  IS_DEV_RELEASE_CHANNEL,
);
export const SERV2_FALLBACK =
  (import.meta.env.VITE_SERV2_FALLBACK as string | undefined)?.trim()
  || (IS_DEV_RELEASE_CHANNEL ? PROD_SERV2_URL : DEV_SERV2_URL);
export const LEGACY_ROSTER_BRIDGE_ENABLED =
  String(import.meta.env.VITE_LEGACY_ROSTER_BRIDGE_ENABLED ?? "false").trim().toLowerCase() === "true";

export const SUCCESS_URL = resolveReleaseChannelUrl(
  import.meta.env.VITE_SUCCESS_URL as string | undefined,
  PROD_CABINET_URL,
  DEV_CABINET_URL,
  IS_DEV_RELEASE_CHANNEL,
);
export const FAIL_URL = resolveReleaseChannelUrl(
  import.meta.env.VITE_FAIL_URL as string | undefined,
  PROD_CABINET_URL,
  DEV_CABINET_URL,
  IS_DEV_RELEASE_CHANNEL,
);
export const GAMES_MASTER_SERVICE_ID = import.meta.env.VITE_GAMES_MASTER_SERVICE_ID as string | undefined;
export const BOOKING_CANCEL_REFUND_TYPE =
  (import.meta.env.VITE_BOOKING_CANCEL_REFUND_TYPE as string | undefined) ?? "TO_CARD";
export const SUPPORT_API_BASE =
  (import.meta.env.VITE_SUPPORT_API_BASE as string | undefined)?.trim()
  || ACTIVE_LK_ASSET_BASE_URL;
export const SUPPORT_WEB_CONNECTOR =
  (import.meta.env.VITE_SUPPORT_WEB_CONNECTOR as string | undefined) ?? "WEB_LK";
export const ACADEMY_SUPPORT_CONNECTOR =
  (import.meta.env.VITE_ACADEMY_SUPPORT_CONNECTOR as string | undefined) ?? "WEB_ACADEMY";
export const PUSH_REGISTRATION_URL =
  (import.meta.env.VITE_PUSH_REGISTRATION_URL as string | undefined)?.trim()
  || `${ACTIVE_LK_ASSET_BASE_URL}/push/register`;
export const PUSH_UNREGISTRATION_URL =
  (import.meta.env.VITE_PUSH_UNREGISTRATION_URL as string | undefined)?.trim()
  || `${ACTIVE_LK_ASSET_BASE_URL}/push/unregister`;

export const GAMES_BUNDLE_URL = resolveOverlayBundleUrl(
  import.meta.env.VITE_GAMES_BUNDLE_URL as string | undefined,
  "games",
  IS_DEV_RELEASE_CHANNEL,
);
export const TOURNAMENTS_BUNDLE_URL = resolveOverlayBundleUrl(
  import.meta.env.VITE_TOURNAMENTS_BUNDLE_URL as string | undefined,
  "tournaments",
  IS_DEV_RELEASE_CHANNEL,
);
export const ONBOARDING_BUNDLE_URL = resolveOverlayBundleUrl(
  import.meta.env.VITE_ONBOARDING_BUNDLE_URL as string | undefined,
  "onboarding",
  IS_DEV_RELEASE_CHANNEL,
);
export const LEVELS_INFO_BUNDLE_URL = resolveOverlayBundleUrl(
  import.meta.env.VITE_LEVELS_INFO_BUNDLE_URL as string | undefined,
  "levels-info",
  IS_DEV_RELEASE_CHANNEL,
);
export const COMMUNITIES_BUNDLE_URL = resolveOverlayBundleUrl(
  import.meta.env.VITE_COMMUNITIES_BUNDLE_URL as string | undefined,
  "communities",
  IS_DEV_RELEASE_CHANNEL,
);
export const TOURNAMENT_SIGNUP_BUNDLE_URL = resolveOverlayBundleUrl(
  import.meta.env.VITE_TOURNAMENT_SIGNUP_BUNDLE_URL as string | undefined,
  "tournament-signup",
  IS_DEV_RELEASE_CHANNEL,
);
export const PHAB_API_BASE =
  (import.meta.env.VITE_PHAB_API_BASE as string | undefined) ?? "https://padlhub.su/api";
export const PUBLIC_INVITE_ORIGIN = (import.meta.env.VITE_PUBLIC_INVITE_ORIGIN as string | undefined) ?? "https://padlhub.ru";
export const PUBLIC_INVITE_PATH = (import.meta.env.VITE_PUBLIC_INVITE_PATH as string | undefined) ?? "/game_join";
export const PUBLIC_GAME_CREATE_PATH =
  (import.meta.env.VITE_PUBLIC_GAME_CREATE_PATH as string | undefined) ?? "/game_create";
export const PUBLIC_GAME_FIND_PATH =
  (import.meta.env.VITE_PUBLIC_GAME_FIND_PATH as string | undefined) ?? "/finde_game";
export const PUBLIC_COMMUNITY_JOIN_PATH =
  (import.meta.env.VITE_PUBLIC_COMMUNITY_JOIN_PATH as string | undefined) ?? "/community_join";
export const CABINET_URL = resolveReleaseChannelUrl(
  import.meta.env.VITE_CABINET_URL as string | undefined,
  PROD_CABINET_URL,
  DEV_CABINET_URL,
  IS_DEV_RELEASE_CHANNEL,
);
export const ACADEMY_CABINET_URL =
  (import.meta.env.VITE_ACADEMY_CABINET_URL as string | undefined) ?? "https://ffc.team/lk_new";

export const RUNTIME_CONFIG_AUDIT = Object.freeze({
  marker: `lk-runtime-config-v1:${IS_DEV_RELEASE_CHANNEL ? "dev" : "prod"}`,
  channel: IS_DEV_RELEASE_CHANNEL ? "dev" : "prod",
  apiBase: API_BASE,
  keycloakBase: KEYCLOAK_BASE,
  tenantKey: TENANT_KEY,
  serv2: SERV2,
  serv2Fallback: SERV2_FALLBACK,
  legacyRosterBridgeEnabled: LEGACY_ROSTER_BRIDGE_ENABLED,
  supportApiBase: SUPPORT_API_BASE,
  gamesBundleUrl: GAMES_BUNDLE_URL,
  tournamentsBundleUrl: TOURNAMENTS_BUNDLE_URL,
  onboardingBundleUrl: ONBOARDING_BUNDLE_URL,
  levelsInfoBundleUrl: LEVELS_INFO_BUNDLE_URL,
  communitiesBundleUrl: COMMUNITIES_BUNDLE_URL,
  pushRegistrationUrl: PUSH_REGISTRATION_URL,
  pushUnregistrationUrl: PUSH_UNREGISTRATION_URL,
});

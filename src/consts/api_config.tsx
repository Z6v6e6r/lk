import { resolveOverlayBundleUrl } from "../utils/overlayBundleUrl";

export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) || "https://api.vivacrm.ru";
export const KEYCLOAK_BASE = import.meta.env.VITE_KEYCLOAK_BASE as string;
export const TENANT_KEY =
  (import.meta.env.VITE_TENANT_KEY as string | undefined) || "iSkq6G";
export const SERV2 = import.meta.env.VITE_SERV2 as string;
export const SERV2_FALLBACK = import.meta.env.VITE_SERV2_FALLBACK as string | undefined;
export const IS_DEV_RELEASE_CHANNEL = import.meta.env.MODE === "dev";

export const SUCCESS_URL = import.meta.env.VITE_SUCCESS_URL as string;
export const FAIL_URL = import.meta.env.VITE_FAIL_URL as string;
export const GAMES_MASTER_SERVICE_ID = import.meta.env.VITE_GAMES_MASTER_SERVICE_ID as string | undefined;
export const BOOKING_CANCEL_REFUND_TYPE =
  (import.meta.env.VITE_BOOKING_CANCEL_REFUND_TYPE as string | undefined) ?? "TO_CARD";
export const SUPPORT_API_BASE = import.meta.env.VITE_SUPPORT_API_BASE as string | undefined;
export const SUPPORT_WEB_CONNECTOR =
  (import.meta.env.VITE_SUPPORT_WEB_CONNECTOR as string | undefined) ?? "WEB_LK";
export const ACADEMY_SUPPORT_CONNECTOR =
  (import.meta.env.VITE_ACADEMY_SUPPORT_CONNECTOR as string | undefined) ?? "WEB_ACADEMY";
export const PUSH_REGISTRATION_URL =
  import.meta.env.VITE_PUSH_REGISTRATION_URL as string | undefined;
export const PUSH_UNREGISTRATION_URL =
  import.meta.env.VITE_PUSH_UNREGISTRATION_URL as string | undefined;

export const GAMES_BUNDLE_URL = import.meta.env.VITE_GAMES_BUNDLE_URL as string | undefined;
export const TOURNAMENTS_BUNDLE_URL = resolveOverlayBundleUrl(
  import.meta.env.VITE_TOURNAMENTS_BUNDLE_URL as string | undefined,
  "tournaments",
  IS_DEV_RELEASE_CHANNEL,
);
export const ONBOARDING_BUNDLE_URL = import.meta.env.VITE_ONBOARDING_BUNDLE_URL as string | undefined;
export const LEVELS_INFO_BUNDLE_URL = import.meta.env.VITE_LEVELS_INFO_BUNDLE_URL as string | undefined;
export const COMMUNITIES_BUNDLE_URL = import.meta.env.VITE_COMMUNITIES_BUNDLE_URL as string | undefined;
export const TOURNAMENT_SIGNUP_BUNDLE_URL = import.meta.env.VITE_TOURNAMENT_SIGNUP_BUNDLE_URL as string | undefined;
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
export const CABINET_URL = (import.meta.env.VITE_CABINET_URL as string | undefined) ?? "https://padlhub.ru/lk_new";
export const ACADEMY_CABINET_URL =
  (import.meta.env.VITE_ACADEMY_CABINET_URL as string | undefined) ?? "https://ffc.team/lk_new";

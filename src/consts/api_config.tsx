export const API_BASE = import.meta.env.VITE_API_BASE as string;
export const KEYCLOAK_BASE = import.meta.env.VITE_KEYCLOAK_BASE as string;
export const TENANT_KEY = import.meta.env.VITE_TENANT_KEY as string;
export const SERV2 = import.meta.env.VITE_SERV2 as string;
export const SERV2_FALLBACK = import.meta.env.VITE_SERV2_FALLBACK as string | undefined;

export const SUCCESS_URL = import.meta.env.VITE_SUCCESS_URL as string;
export const FAIL_URL = import.meta.env.VITE_FAIL_URL as string;

export const GAMES_BUNDLE_URL = import.meta.env.VITE_GAMES_BUNDLE_URL as string | undefined;
export const TOURNAMENTS_BUNDLE_URL = import.meta.env.VITE_TOURNAMENTS_BUNDLE_URL as string | undefined;

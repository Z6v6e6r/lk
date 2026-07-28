export {};

declare global {
  interface Window {
    __LK_RELEASE_VERSION__?: string;
    __LK_BASE_URLS__?: string[];
    __LK_ACTIVE_BASE_URL__?: string;
    __LK_API_BASE_URLS__?: string[];
    __LK_AUTH_MODE__?: "legacy" | "viva";
  }
}

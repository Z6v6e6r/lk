/** Absolute asset root supplied by the dedicated Tilda pilot bootstrap. */
export function getLkPilotAssetBase(): string | null {
  if (import.meta.env?.VITE_LK_READ_ONLY_PILOT !== "true" || typeof window === "undefined") {
    return null;
  }

  const root = (window as Window & { __LK_PILOT_ASSET_BASE__?: string }).__LK_PILOT_ASSET_BASE__;
  if (!root) throw new Error("LK pilot bootstrap is required");
  return root;
}

/**
 * Strict pilot route switch.
 *
 * The new residency purchase screen is an additional entry point on the same LK1 bundle:
 *   /lk_new?buyResidency=lifecycle          (direct entry)
 *   /lk_new?phResidencyLifecycleReturn=1    (bank return, no purchase is started)
 *
 * The old `buyResidency=1` / `phCheckoutReturn=residency` routes are never matched here,
 * so an old client keeps its page and a cached old page cannot be resumed as the pilot.
 */
export type ResidencyLifecycleRoute = "purchase" | "return";

export function readResidencyLifecycleRoute(search: string, previewOnly = false): ResidencyLifecycleRoute | null {
  const params = new URLSearchParams(search);
  const purchase = params.getAll("buyResidency");
  const lifecycleReturn = params.getAll("phResidencyLifecycleReturn");
  const oldReturn = params.getAll("phCheckoutReturn");
  const qr = params.getAll("residency");

  if (purchase.length === 1 && purchase[0] === "lifecycle") {
    if (lifecycleReturn.length || oldReturn.length || qr.length) return null;
    return "purchase";
  }
  if (!previewOnly && lifecycleReturn.length === 1 && lifecycleReturn[0] === "1") {
    if (purchase.length || oldReturn.length || qr.length) return null;
    return "return";
  }
  return null;
}

export function residencyLifecyclePurchaseUrl(): string {
  return "/lk_new?buyResidency=lifecycle";
}

export function residencyLifecycleLegacyUrl(): string {
  return "/lk_new?buyResidency=1";
}

// Feature flag: storefront (#339) design for the game-join checkout.
// Owner: PadlHub LK1. Purpose: roll out the new storefront over the existing
// server-owned join handlers. Activation: owner approval after isolated-contour
// acceptance of the GJ rows. Removal/review: remove the legacy join UI branch
// once the flag is on for all tenants, or review by 2027-01-31.
export const STOREFRONT_CHECKOUT_ENABLED = import.meta.env.VITE_LK1_STOREFRONT_CHECKOUT === "1";

// Startup configuration for the approved annual HAB price; no quota or admission changes.
global.set("summer_subscription_network_friendship_price_98000_enabled", true);
if (global.get("summer_subscription_network_friendship_price_98000_enabled") !== true) {
  throw new Error("HAB annual price configuration readback mismatch");
}

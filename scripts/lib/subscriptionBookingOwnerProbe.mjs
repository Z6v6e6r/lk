export const OWNER_CAPABILITY_GET_ID = 'lk_subscription_booking_owner_probe_get_20261023';

// Both supported composers create the same inert entry into the canonical owner.
export function buildOwnerCapabilityGetNode(tabId) {
  if (typeof tabId !== 'string' || !tabId) throw new Error('Owner capability tab is required');
  return { id: OWNER_CAPABILITY_GET_ID, type: 'http in', z: tabId,
    name: 'GET subscription booking owner capability', url: '/lk/subscription-bookings',
    method: 'get', upload: false, swaggerDoc: '', x: 200, y: 5350,
    wires: [['lk_subscription_booking_options_20260804']] };
}

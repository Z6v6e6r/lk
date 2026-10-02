import fs from 'node:fs';
import { buildSubscriptionBookingNginxCandidate } from './patch_subscription_booking_proxy.mjs';

export function buildTrialGroupBookingProxy(source, expectedSourceSha) {
  const fragment = fs.readFileSync(new URL('./lk-trial-group-booking-location.conf', import.meta.url), 'utf8');
  return buildSubscriptionBookingNginxCandidate(source, expectedSourceSha, fragment,
    /location\s*=\s*\/lk\/trial-group-bookings\s*\{/g);
}

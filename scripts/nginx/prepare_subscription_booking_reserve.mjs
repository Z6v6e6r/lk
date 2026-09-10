import fs from 'node:fs';
import {buildSubscriptionBookingNginxCandidate} from './patch_subscription_booking_proxy.mjs';

export const reserveBookingLocation = () => fs.readFileSync(
  new URL('./lk-subscription-booking-reserve-location.conf', import.meta.url), 'utf8');

// The reserve host serves assets with try_files rather than the primary alias.
export function buildReserveBookingNginxCandidate(source, expectedSourceSha) {
  return buildSubscriptionBookingNginxCandidate(source, expectedSourceSha,
    reserveBookingLocation(), /location\s*=\s*\/lk\/subscription-bookings\s*\{/g,
    '    location /lk/ {\n        try_files $uri =404;\n    }');
}

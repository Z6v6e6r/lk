import fs from 'node:fs';
import {buildSubscriptionBookingNginxCandidate} from './patch_subscription_booking_proxy.mjs';
export const previewLocation = target => {
  if (!['primary', 'reserve'].includes(target)) throw new Error('Explicit primary/reserve target required');
  return fs.readFileSync(new URL(target === 'primary' ? './lk-subscription-price-preview-location.conf'
    : './lk-subscription-price-preview-reserve-location.conf', import.meta.url), 'utf8');
};
export function buildSubscriptionPricePreviewNginxCandidate(source, expectedSourceSha, target) {
  return buildSubscriptionBookingNginxCandidate(source, expectedSourceSha, previewLocation(target),
    /location\s*=\s*\/lk\/subscriptions\/game-price-preview\s*\{/g);
}

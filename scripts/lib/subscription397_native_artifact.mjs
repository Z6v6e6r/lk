import { subscriptionBookingPaginationEdits, subscriptionPreviewPaginationEdits } from '../prepare_subscription_booking_pagination.mjs';
import { subscriptionDateExclusionBlock } from '../prepare_subscription_history_release.mjs';
import { SUBSCRIPTION397_IDS, validateSubscription397Artifact } from './subscription397_native_patch.mjs';
// These snippets come from the merged product source, never a production flow.
export function buildSubscription397Artifact() {
  const anchor = '  if (!eventRoute && (canonical.preflightAvailability.resolveSplitSubscriptionLifecycle';
  return validateSubscription397Artifact({
    [SUBSCRIPTION397_IDS[0]]: subscriptionBookingPaginationEdits(),
    [SUBSCRIPTION397_IDS[1]]: [...subscriptionPreviewPaginationEdits(), [anchor, subscriptionDateExclusionBlock + anchor]],
  });
}

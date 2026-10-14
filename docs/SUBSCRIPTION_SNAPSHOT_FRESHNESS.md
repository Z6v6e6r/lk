# LK1 subscription balance freshness

Owner: LK1 subscription-cache owner. Audience: signed-in LK1 users viewing their
owned subscriptions in cabinet, games and schedule widgets.

Subscription lists use the existing authorized GET through `apiFetchSubscriptions`.
Each completed read is refreshed on the next call, with browser `no-store`.
Only overlapping in-flight requests for the same account, environment and query key
are shared. Lists and balances are not restored from or persisted to the 12-hour
snapshot. A legacy persisted entry for the requested list key is removed on read.
The existing snapshot for subscription names remains unchanged.

This refresh runs when an existing caller loads its subscription list, including
page navigation/reload and the existing post-booking refresh. It adds no background
poller, focus listener, timer, endpoint or subscription debit. Data already displayed
in an idle page is not continuously updated without another existing load action.

Existing invalidation around possible entitlement writes and the generation fence
remain in place. An invalidated or previous-account response cannot refill or return
the old result. The same fence now also applies when Web Crypto is unavailable, the
token is absent, or the token cannot yield a cache scope. Account digests partition
display data only; they never establish authentication or entitlement.

Cabinet initial load and post-booking refresh share one subscription-load sequence.
Subscription/referral state is applied only by the latest sequence while the
captured token and invalidation epoch are still current. This also rejects an old
subscription result already waiting inside `Promise.all` for a slower sibling.
Initial cache-scope restoration is not a write invalidation. An old failed batch
cannot clear a newer successful list. Unrelated profile/booking setters are unchanged.

Source failures and malformed success payloads produce unavailable data. A genuine
zero remains zero; missing balance data is never synthesized as zero. Failed cabinet
refresh clears the previous list and announces unavailable subscriptions separately
from a confirmed empty list. An open information panel resolves the selected exact
subscription ID from the current list; it cannot retain its old balance object or
adopt another list row. Booking, price and benefit decisions still belong to the
existing server owners.

Stop signal: account/generation drift, unavailable/malformed source or failed source
validation. Stop method: discard the old response, show unavailable data and allow a
later existing refresh; never compensate, debit or run a replacement business command.

LOCAL regression uses the existing Node/esbuild/VM and React static-render contour
with synthetic responses only. No new test stack or dependency is installed. Static
render and source checks do not establish browser/device or production acceptance.

Runtime DoD, pending separate exact execution authority:

1. Publish reviewed exact source through the existing guarded release route.
2. Under an authorized account, compare a fresh source balance with the displayed
   exact subscription instance; a later existing reload must read the new source.
3. Delay an old response, invalidate or switch account, then complete it: neither
   previous-user data nor the old balance may appear.
4. Switch the selected subscription and refresh an open information panel: identity
   remains exact and the current list supplies the balance.
5. Make the source unavailable: show unavailable data, not zero or an empty account;
   a genuine source zero remains visible as zero.

No real booking, payment or debit is needed or authorized by this document. Source,
LOCAL, CI, rendered browser/device, provider and production are separate evidence.

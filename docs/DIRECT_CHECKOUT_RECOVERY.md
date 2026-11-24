# Bounded Friendship 2.0 checkout recovery

Friendship 2.0 uses direct Viva transactions, not the monthly subscription sales
ledger. Its pending browser guards must not be cleared using a monthly sale receipt.
This recovery reads an exact saved transaction; it neither expires nor creates a
provider payment and never guesses a lost transaction ID.

The existing confirm endpoint accepts the opt-in body
`{ directCheckoutRecoveryVersion: 1, transactionId }` with the current checkout
Bearer. A present invalid version fails closed. Legacy requests keep their original
flow. The new mode goes through a fixed impossible Mongo `find` and then uses only
HTTP and response ports: current-user profile, service authentication, exact admin
transaction read. Outbound URLs are fixed, redirects disabled, timeouts bounded.

The server requires a transaction-bound frozen operator fingerprint and fresh
matching owner ID/phone, exact product and amount, terminal `REJECTED/EXPIRED` card,
unchanged payment channel, card/link/legs, original discount/amount and deadline, and no paid/refund/issued
or processing evidence. Fingerprints include the random transaction ID, tenant and
product; no standalone phone hashes or customer exports belong in Git. The private
proof set is immutable and keeps newer/ambiguous transactions outside this repair.

A verified response releases only exact unpaid browser guards under account/product
and offer locks, after rechecking both authentication stores and every raw marker.
A current trusted click can create once at the same displayed price, with the
one-day activation term. A restored page may clear closed guards but cannot create.
Old invoice discounts are frozen and checked; replacements use the newly displayed quote.
Paid markers, explicit transaction conflicts, unknown IDs and errors retain guards.

Release uses `scripts/patch_direct_checkout_recovery.mjs` against a fresh private
live pull. It pins three function preimages and all sensitive route/transport
wiring, preserves legacy bodies, and rejects catches covering any recovery node. The
private proof input and full flow remain outside Git. Use the existing reviewed
function-only contract, retained backups, clean pushed source, and public API/UI
postchecks. Do not erase browser storage to bypass an unknown payment.

## Standard RA on /sub_hab

RA uses the same direct confirmation request with the regular Viva product
`b91e14d1-fe6e-4d0b-be39-3e45ad86b759`. The server selects the proof set by
transaction-bound fingerprint. RA proofs require a single 23,800 ₽ WIDGET card
payment and a fresh Viva response confirming that it expired unpaid. Each proof
also binds the owner, amount, bank payment and deadline. The same endpoint
continues to accept the installed Friendship 2.0 proof set.

The storefront can reconcile an exact saved RA transaction on page load. A
fresh trusted click can retry once at the displayed price after a closure.
The separate RA regional offer uses a different Viva product. Missing IDs,
other declines, separate payment methods and transactions outside the approved
proof set retain their existing custody.

Prepare the extension with the verified current production flow and the
private reviewed RA proofs:

```sh
node scripts/patch_direct_checkout_recovery.mjs --extend-ra \
  /absolute/fresh-live-workspace /absolute/private-ra-proofs.json /absolute/new-candidate.json
```

The extension verifies the installed prefix of all three functions and the
existing route topology. It replaces only the resolver and router function
prefixes and carries forward the frozen Friendship 2.0 configuration. Compare
the two-function delta, rehearse the confirmation route and its inverse, then
follow the reviewed release contract. Publish the storefront after backend
confirmation readback.

## Live verification for the standard RA invoice

Version 2 of `POST /lk/tournaments/summer-subscription/confirm` accepts only
`{ directCheckoutRecoveryVersion: 2, transactionId }`. The version itself
selects standard RA. No product, phone, payment amount, or provider URL is taken
from the browser. The handler resolves the current Viva profile first, then reads
the exact admin transaction and verifies the same owner, standard RA product,
matching totals and one WIDGET card leg. Full-price and discounted invoices use
the same checks. A terminal expiry, the existing grace period and absence of
payment, processing, issuance, refund or receipt evidence are required. The
route admits at most six new version-2 checks per second per Node-RED process.
It returns fresh proof of that invoice's closure without returning a provider
link, phone number or credential.

RA card recovery and the promo button can lift a marker only for the stored,
exact transaction under the existing actor/product and offer locks. A promo
marker without a transaction ID remains pending. Reconciliation does not create
an invoice. A dedicated user action must confirm a fresh quote before sending a
new purchase. This closes a known attempt in this browser; it does not infer
the status of a different invoice or provide cross-device purchase deduplication.

Prepare from a fresh 147 workspace with both original frozen proof sets:

```sh
node scripts/patch_direct_checkout_recovery.mjs --enable-ra-live \
  /absolute/fresh-live-workspace /absolute/new-candidate.json
```

The patcher verifies the three function prefixes, legacy suffixes, shared
transport and wires. The candidate changes only those three function bodies
and preserves both frozen version-1 proof sets. The initial install and
`--extend-ra` modes keep version 2 disabled. Publish the verified backend
before the storefront. A storefront that encounters an explicit v1 protocol
rejection can use the existing frozen check; timeout, throttle and denial do not
trigger a second provider lookup. Verify an expired standard RA purchase with
and without a discount, an active or paid invoice, a second actor, a concurrent
tab and a lost response before activation. Rollback must preserve the original
v1 recovery path and the exact browser markers, so an unresolved payment
continues to block another create.

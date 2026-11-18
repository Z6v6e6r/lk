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

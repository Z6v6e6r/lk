# R03: explicit background response ownership

Owner: this focused R03 source task. Audience: LK1 Node-RED maintainers.
Observable source result: detached reconciliation continuations keep their internal
result and never use the HTTP response output in the two reproduced paths.
Stop signal: source/topology drift or a foreground compatibility regression.
Stop method: do not build/import a candidate; no activation is authorized here.

## Evidence and scope

The inspected post-218 flow SHA256 is
`0d19e63464a71fa6b0b66edd938ca4ede94c9fcc84fd236134ec98699ebd0497`.
All nine parent function texts and the two background anchor texts match source
commit `504d008502c9f40c96526b761b4e3de0a31f01dc`. Exact hashes and full outgoing
wires are recorded in `scripts/lk1_r03_response_generation.json`. This is a saved
source snapshot, not a new production measurement or a current deployment claim.

The shared HTTP response node is `10fe94a32b8adc35`; its historical/current-snapshot
config hash is `7d05a82805c3fab0cb57dc65125329e6d2f2d08b4a89c01b0e1a712905d8a79e`.
In the saved 23 October 2026 window (13:35:09–14:02:24 MSK), it emitted five
`No response object` warnings at 13:57:41/13:57:54 MSK. The older 37-window slice
contained 145 warnings. These are Node-RED events, not HTTP requests or users.
There is no branch/request correlation in those records. The five separate
background ledger diagnostics are not evidence of identity with those warnings.

**Historical R03 causes remain OPEN/unresolved.** The local source defects below
are confirmed; attribution of the historical or post-218 events to either defect
is not established. No later silence or passing test closes that attribution.

## All nine incoming branches

Ports below are zero-based. `req/res` refer to the same original HTTP handles.

| Parent ID | Source under scripts/nodered_games_nodes/ | HTTP port | Ownership trace / outcome |
|---|---|---:|---|
| `1da9af2cb4f7db52` | `fn_tournament_subscription_confirm_prepare.js` | 1 | Only HTTP input `80379d333be8dfca`; failure returns original msg, successful DB message uses shallow copy. Client payload does not set reconcile ownership. |
| `91dded2dc8cfebe4` | `fn_tournament_subscription_purchase_prepare.js` | 1 | Only HTTP input `c7e68185e6e3abcc`; errors return original msg; DB message retains handles. |
| `f8679e53edadc39b` | `fn_tournament_subscription_purchase_limit.js` | 1 | Mongo continuation from purchase_prepare; shallow response copy retains handles. Handle deletion affects its separate debug copy, not original/HTTP message. |
| `566ae4b886c37ae5` | `fn_tournament_subscription_purchase_router.js` | 2 | HTTP request continuations include background confirmation. Normal confirmation success already suppresses its HTTP response for reconcile=true. **Generic fail did not**: token_confirm error reproduced no-res response. Fixed here. Managed projection detaches only its background atomic message as in218. |
| `ca022fd14027a5b0` | `fn_tournament_subscription_confirm_resolve.js` | 1 | Receives foreground Mongo reads, poll admit/ack and detached reconcile_record. **failMsg and cached no-transaction response did not suppress HTTP**. Fixed here; existing stopped-poll background guard remains. |
| `piter_atomic_router_20260903` | `fn_tournament_subscription_piter_atomic_router.js` | 3 | Error and managed-projection terminal paths already guard reconcile=true. Confirmation-result paths carry the explicit reconcile flag from purchase_router. Existing error/background tests remain; no unrelated atomic logic changes. |
| `piter_atomic_error_20260903` | `fn_tournament_subscription_piter_atomic_error.js` | 0 | Scoped Mongo catch; with original context,218 already suppresses background HTTP and retains internal output. Error-only catch losing original context/handles is a separate unproven possibility; not silently classified as background. |
| `subscription_poll_admit_20260914` | `fn_tournament_subscription_poll_admit.js` | 2 | Missing identity/stopped background returns null. Eligible jobs use durable no-upsert CAS before returning to resolve. Foreground HTTP failure retains handles. |
| `subscription_poll_ack_20260914` | `fn_tournament_subscription_poll_ack.js` | 1 | Ambiguous/error CAS ACK returns null for background; foreground error retains handles. Successful ACK returns original continuation to resolve. |

Standard Node-RED clone semantics preserve top-level req/res identity; `_msgid`
does not reconstruct them. Read-only local checks of installed Node-RED 4.0.8 and
3.1.3 confirmed this. The exact installed147 Mongo4 implementation was not read or
claimed equivalent to the locally installed legacy Mongo package. Regression
Mongo edges explicitly model payload replacement while preserving the message.
No real Mongo/provider service is invoked by the tests.

## Two local reproductions

1. `subscription_poll_dispatch_20260914` (`reconcile_dispatch`) executes
   `node.send({ payload: record })`: it creates an intentionally detached job,
   rather than accidentally serializing an HTTP response.
   `ab1e202650000006` (`reconcile_record`) sets `reconcile: true` and forwards it to
   resolve. A synthetic acknowledged CAS passes through the real poll_admit and
   poll_ack sources. Invalid annual-history ledger validation then called
   confirm_resolve.failMsg, which copied this job onto HTTP port1 without res.
2. A detached `reconcile: true`, `step: token_confirm` provider-error continuation
   called purchase_router.fail and reached HTTP port2 without res. No HTTP request
   is made: the fixture supplies the existing provider response as input.

The tests execute the immutable pre-fix Git source for both reproductions, then
check the current source. They also reproduce the resolver's cached
no-transaction terminal response. Original circular, method-bearing req/res are
checked by strict identity across modeled clone/DB edges; they are never passed
through JSON or structuredClone as ordinary payload data.

## Minimal runtime fix

Only two function bodies change:

- confirm_resolve centralizes its existing error/cached response ports. A strict
  `msg._summerSubscriptionCtx?.reconcile === true` removes only the HTTP output;
  the same internal response is retained on port2. Background failures emit only
  fixed event/code plus integer status: `subscription_confirm_background_failed`,
  `SUBSCRIPTION_CONFIRM_BACKGROUND_FAILED`.
- purchase_router.fail uses the same ownership rule, retaining internal output
  on port3. Its fixed diagnostic is `subscription_router_background_failed`,
  `SUBSCRIPTION_ROUTER_BACKGROUND_FAILED` plus status.

No `!msg.res` blanket drop is introduced. Missing foreground context or handles
remain visible; foreground status/body/reference behavior matches the pre-fix
source. A payload `reconcile: true` cannot select this internal ownership flag.
No payment/booking/provider result, admission/CAS, retry, quota or routing policy
changes. Internal debug output remains unchanged. The new warning fields contain
no payload/error/details/URL/token/customer identifiers.

## Source generations and offline binding

`lk1_error_source_generation.json` remains byte-for-byte frozen. The new successor
pins only purchase_router and confirm_resolve. The generic source-pin registry and
five-output topology recognition consume the new hashes. The old offline binder
accepts explicit source texts for reproducing its frozen predecessor, still with
strict original candidate hashes; it never silently upgrades to this successor.

`patchR03ResponseSources()` is an offline/in-memory function. It verifies the nine
incoming response parents, enabled tab, exact function preimages/outgoing wires
and dispatcher/record anchors, then replaces exactly two func fields. It refuses
foreign parents, disabled nodes/tabs, changed sources/wires, missing/duplicate IDs
and reapplication. It grants no deploy authority. Whole-flow exact graph contract
validation remains a separate gate; it is tested against a synthetic graph and
checked locally against the private saved full-flow snapshot without exporting it.

The existing exact-head CI includes the new lifecycle suite and the frozen218
suite. Existing polling-generation checks follow the newest source pins without
rewriting historical hashes.

## Checks and remaining limits

Run:

```bash
node --test scripts/tests/lk1R03ResponseLifecycle.test.mjs
node --test scripts/tests/lk1ErrorSourceFixes.test.mjs scripts/tests/subscriptionPaymentPolling.test.mjs
```

Regression scope includes both red-to-green failures, background errors/cached
success, foreground before/after compatibility, nine response parents, existing
atomic/poll guards, client-body isolation, strict source/graph drift and immutable
predecessor pins. Existing payment, annual-history and atomic suites also apply.
Full CI covers the actual committed tree; a green result is source evidence only.

The exact production origins of the saved five/145 warnings and their business
outcome remain unresolved. These fixtures do not prove every possible catch/Mongo
failure mode. Future deployment requires separate authority and fresh owner,
preimage, runtime/lease/topology guards. No server reads/writes, merge/deploy,
import/restart, business replay, provider/DB operations or monitor checkpoint edits
are part of preparing this Draft PR.

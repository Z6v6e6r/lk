# Residency #452 — durable activation ambiguity

Ticket: Z6v6e6r/lk#452. Base head: `8d84168c8b46540c8f9f0473bc35c904223ec292`.
Code head: `158251bfc9e271e2b7cc140f86d0c53345f6200d`. This evidence is a later
docs-only commit. Scope: the residency lifecycle custom node and its tests only. The mass
storefront and the published old checkout were not changed.

## Defect

After a CUP refresh command was claimed, an inconclusive answer reset
`activation.state` to `PENDING`:

- `residency-booking-context` was unavailable;
- the refresh itself timed out or its response was lost;
- the activation port had no context read;
- the instance lookup or external conflict read failed after the claim.

The next reconcile then computed `recovering=false`, skipped the read-only context and
called `residency-booking-refresh` again. A retry or a process restart could therefore
issue a second activation command for one confirmed payment. A separate pre-existing
defect let `ACTIVATION_FAILED` re-enter `activate()` on every later reconcile.

## Fix

1. A claimed refresh with an inconclusive result is stored as
   `activation.state=UNKNOWN`, not `PENDING`.
2. `IN_FLIGHT` and `UNKNOWN` are the durable ambiguous states. A stale `IN_FLIGHT`
   and every `UNKNOWN` pass read `residency-booking-context` (refresh false) before any
   command.
3. Every inconclusive path preserves the marker: unavailable context, missing context
   port, refresh timeout/lost response, failed instance lookup, instance before the
   order and an unavailable external conflict read.
4. The provider's read-only context now returns `NOT_ACTIVE` for a well-formed answer
   with no instance or a non-ACTIVE instance. A malformed response still throws, so it
   cannot be mistaken for "not applied".
5. An explicit `NOT_ACTIVE` context authorizes **one** bounded retry. The retry counter
   is persisted by CAS before the command, so a crash after that write cannot produce a
   second retry. If the retry does not produce `ACTIVE`, the paid order moves to
   `PAID_REQUIRES_REVIEW` / `ACTIVATION_RECOVERY_EXHAUSTED`.
6. `ACTIVATION_FAILED` is no longer activation-eligible, so an explicit rejection is not
   refreshed again by a later reconcile.
7. A fresh `IN_FLIGHT` (under the 120 s lease) still returns without a command, so two
   concurrent workers cannot both refresh.

## Reproduction on the old head

```bash
SOURCE_HEAD=8d84168c8b46540c8f9f0473bc35c904223ec292 \
  node repro-ambiguity.mjs
```

Result in `before.json`:

| Case | activate calls | context reads | final order |
| --- | ---: | ---: | --- |
| lost answer, then context down, then restart | **3** | 0 | `PAID_ACTIVATION_PENDING` |
| successful refresh, lost ACTIVE write, then context down | **3** (1 real + 2 repeated) | 1 | `PAID_ACTIVATION_PENDING` |
| lost answer, then explicit NOT_ACTIVE, retry succeeds | 2 | 0 | `ACTIVE` (blind retry, no context) |
| lost answer, NOT_ACTIVE, retry still pending | **3** | 0 | `ACTIVE` on the third blind retry |
| CUP rejection, then another reconcile | **2** | 0 | `ACTIVATION_FAILED` |

The second case is the externally reported G8: the first context read proves the marker
was lost, and the next two reconciles (including the restarted process) send refresh again.

## Reproduction after the fix

```bash
SOURCE_HEAD=158251bfc9e271e2b7cc140f86d0c53345f6200d \
  node repro-ambiguity.mjs
```

Result in `after.json`:

| Case | activate calls | context reads | final order |
| --- | ---: | ---: | --- |
| lost answer, then context down, then restart | **1** | 2 | `PAID_ACTIVATION_PENDING` / `UNKNOWN` |
| successful refresh, lost ACTIVE write, then context down | **1** | 3 | `PAID_ACTIVATION_PENDING` / `UNKNOWN` |
| lost answer, then explicit NOT_ACTIVE, retry succeeds | 2 | 1 | `ACTIVE` (one bounded retry) |
| lost answer, NOT_ACTIVE, retry still pending | 2 | 1 | `PAID_REQUIRES_REVIEW` |
| CUP rejection, then another reconcile | **1** | 0 | `ACTIVATION_FAILED`, no retry |

In the two context-down cases the subsequent reconciles and the restarted process only
read the context; no second command is sent. In the NOT_ACTIVE cases there is exactly one
bounded retry and then either `ACTIVE` or review, never a loop. A single confirmed
payment still produces exactly one activation.

## Checks

```text
node --test scripts/tests/residencyLifecycle.test.mjs                         75/75 PASS
node --test scripts/tests/residencyLifecycleProvider.test.mjs               26/26 PASS
npm run test:residency-lifecycle                                            133 pass, 11 skipped (Mongo)
LK_TEST_MONGO_URI=... node --test scripts/tests/residencyLifecycleMongo.test.mjs  11/11 PASS
npm run test:residency-pilot                                                 11/11 PASS
npm run test:residency-lk1-compat                                             7/7 PASS
npx eslint <changed files>                                                    PASS
git diff --check                                                              PASS
```

## Independent review

A fresh-context reviewer inspected the first fixed head `9fa44bbb` and found two issues:

- **P1:** with the initial provider adapter, any non-ACTIVE context threw, so `UNKNOWN`
  became a dead end for a paid order whose refresh never reached CUP. Fixed by the
  explicit `NOT_ACTIVE` context and the single bounded retry above.
- **P2:** `ACTIVATION_FAILED` was re-eligible and refreshed again. Fixed by removing it
  from the automatic activation path.

The reviewer re-checked `96146f35` (the functional fix) and returned **blocking none**:
P1 and P2 are closed, the normal path is unchanged, and there is no unbounded
duplicate-refresh path. The final `158251bf` only rejects a malformed context instance
(`instance` that is not an object) instead of treating it as `NOT_ACTIVE`; this is
covered by a provider test.

## Boundaries and residual risk

- Synthetic ports only; no real Viva, CUP, Keycloak, payment, 147 import/deploy or data
  mutation was performed.
- There is still a TOCTOU window between the read-only context and the refresh command.
  The guarantee is "no blind repeat; at most one bounded retry after an explicit
  NOT_ACTIVE context", not an atomic provider-side exactly-once constraint.
- A **stale** `NOT_ACTIVE` (CUP cache/replica) could still authorize the one retry even
  though the first command was applied. The context `observedAt` is not compared with
  the claim time, so the hard bound is "at most two commands", not "strictly one".
  Read-after-write consistency of the CUP context must be confirmed before the pilot.
- The `NOT_ACTIVE` contract assumes a well-formed `200` response with a `context`
  object. A missing `context`, `context:null` or HTTP 404 stays `UNKNOWN` without a
  retry and without review.
- A persistently malformed or unavailable context leaves the order `UNKNOWN`; there is
  no operator reset route in the repository. Support would need a manual durable repair.
- A crash after the retry counter is written but before the command reaches CUP sends the
  paid order to review without a second command (deliberate fail-closed).
- The explicit `NOT_ACTIVE` retry is covered by unit tests and provider tests, not by a
  real Mongo restart specifically; the Mongo test covers `UNKNOWN` -> `ACTIVE`.
- If a claimed refresh cannot resolve an instance at all, the order stays `UNKNOWN` and
  requires operator review rather than an automatic second command.
- The Mongo test represents a process restart by a fresh lifecycle instance against the
  same durable Mongo state. No OS-level process restart was performed in this evidence.
- No merge, deploy, publication or real payment is part of this evidence.

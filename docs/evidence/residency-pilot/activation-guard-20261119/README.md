# Activation guard evidence (2026-11-19)

Scope: LK1 residency lifecycle GET read-only contract and pre-activation external
conflict check. This evidence is synthetic and isolated; no real Viva, CUP or Keycloak
call, no payment, no 147 change.

## Commands and results

| Command | Result |
| --- | --- |
| `LK_TEST_MONGO_URI=mongodb://127.0.0.1:27029 npm run test:residency-lifecycle` on disposable `mongo:8.0.5` | **133 pass, 0 fail, 0 skipped** |
| `node --test scripts/tests/residencyLifecycleMongo.test.mjs` with the same disposable Mongo | **10 pass, 0 fail** |
| `npm run test:residency-pilot` | **11 pass, 0 fail** |
| `npm run test:residency-lk1-compat` | **7 pass, 0 fail** |
| `npx eslint` on the changed lifecycle/test files | **0 errors** |
| `git diff --check` | **clean** |

The disposable Mongo container was created only for this run and removed afterwards.
The lifecycle tests use synthetic provider/CUP ports; no money or real provider write is
involved.

## What the new tests assert

- `getOrder`, `listOrders` and `getPayment` do not change `state`, `payment.status`,
  `revision`, `activeSlot` or the durable row, and call neither provider readback nor CUP
  activation.
- A conflicting external `OPEN`, `UNKNOWN` or `PAID` operation blocks activation:
  `PAID_REQUIRES_REVIEW`, `EXTERNAL_PAYMENT_DETECTED`, `activationCalls=0`,
  `findInstanceCalls=0`.
- An immediate `PAID` create checks the external list before its only activation.
- An unavailable external list blocks activation; no CUP command is sent.
- One confirmed payment activates exactly once: first reconcile 1, repeated reconcile 1,
  restart + reconcile 1.
- A bounded IN_FLIGHT claim is not overwritten by a fresh external conflict read; the
  second worker leaves the claim and activation calls at 0.

## Boundary

This proves the engine and HTTP contract on an isolated synthetic stand. It does not
prove the real Viva product format or a real CUP activation; those remain separate
provider/pilot steps.
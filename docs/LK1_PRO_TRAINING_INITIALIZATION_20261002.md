# PRO booking initialization hotfix

PR #175 added PRO predicates to early booking tariff/recheck and daily allowance
paths, but its live patcher replaced the embedded module at its old position,
after those steps. Hoisted functions could therefore read `proTrainingIsRecord`
and other `const` dependencies before initialization. Even ordinary group
training history could interrupt the booking with `ReferenceError`.

`initializeProTrainingBeforeSteps` moves the complete byte-matching reviewed
module before executable steps, checks unique top-level declarations, preserves
strict directives and leaves all other code unchanged. The discount-generation
patcher now uses it too. Discount, ownership, tariff revalidation, visit and
free-first-event rules are unchanged.

## Focused offline candidate

Owner: LK1 booking backend. Audience: subscription group-training bookings.
Affected endpoint: `POST /lk/subscription-bookings`.
Only changed field: `lk_subscription_booking_router_20260804.func`.
Preview, evaluator, initialize fields, all other nodes and wires remain identical.

Reviewed live-147 snapshot: 4,804 nodes.

- Source SHA256: `0dacc3d0264a1d243b163996ef13939ef523e69a44b8f2cfe60729547570e268`
- Booking preimage: `f97b4b2ec40db022257571a0b69f82bc5236ea96013719708cb0d076d7197bb9`
- Booking postimage: `802529aca772e3343d53971d40f8040fbf99ce8764c9aa3b12c06d8717f281e5`
- Deployment ID: `lk1-pro-training-initialization-20261002`

Obtain a fresh private external live workspace using the existing read-only
`nodered:modular:pull-147` command. Build with:

```bash
node scripts/patch_live_lk1_pro_training_initialization.mjs \
  --workspace /private/tmp/new-live-workspace \
  --output /private/tmp/new-pro-initialization-candidate
```

The CLI verifies origin/freshness/permissions and exact source/postimage hashes;
it writes only private candidate/contract files (0600 in a new 0700 directory).
Runtime exports stay outside Git. It never imports, deploys or restarts.

## Verification and release boundary

```bash
node --test scripts/tests/proTrainingInitialization.test.mjs
LK_PRO_TRAINING_INITIALIZATION_LIVE_SNAPSHOT=/private/tmp/new-live-workspace/input/source.flow.json \
  node --test scripts/tests/proTrainingInitialization.test.mjs
```

The hermetic tests execute the complete composed router at early tariff and usage
entry points. They reproduce the TDZ before the move, cover RA/Academy with empty,
ordinary, PRO and mixed history, preserve the 50% PRO price without a visit, and
keep stale-quote refusal. These tests run in CI without a private flow.
The optional snapshot test executes the actual installed function, validates
deterministic one-field composition and rejects source drift/reapplication.

Merge and real apply require explicit authorization. At apply, re-pull and use the
existing reviewed-flow deployment helper with the exact contract, source, lock,
lease, backup and foreign-change protections. Source drift stops preparation;
new ReferenceErrors or changed pricing/visits stop rollout and require investigation.
Postcheck must confirm the installed function hash and both formerly failing
paths. A real booking/payment smoke needs its own named authorization.

Guarded rollback restores the exact prior function but also restores this known
initialization defect. It is recovery from an additional rollout regression, not
a claim that the prior booking code is healthy. This change does not repair
previously interrupted booking operations or retry provider writes.

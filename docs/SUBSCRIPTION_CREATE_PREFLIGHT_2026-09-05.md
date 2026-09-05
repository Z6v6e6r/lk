# Subscription CREATE: reject known failures before occupying a court

The live split CREATE path creates a Viva exercise before checking subscription rules.
A gateway rejection returns directly to HTTP and can leave an exercise with no guests.
This candidate moves the checks that are available before creation ahead of the exercise
POST. It preserves real-exercise eligibility validation and existing booking writes.

## Scope and provenance

This is a narrow patch for the reviewed live baseline, not a replacement with the wider
DEV subscription implementation already on main. Normal frontend builds do not apply it.

- Base commit: `4237fbafe42df9f577356b15487693cc7215d32e`.
- Live source SHA256: `46cf684fce5017e5ff4c5add22e918cfde92d404b651b416b6fdebd30275504a`.
- Exactly three existing function bodies change; topology and all other nodes stay intact:
  `8f7bd5b482fe9763`, `lk_subscription_booking_router_20260804`,
  `lk_subscription_booking_finalize_20260804`.
- Endpoints: existing `POST /lk/games/split/create`, shared subscription gateway,
  authenticated Viva profile/subscriptions/bookings reads, and the existing read-only
  runtime-context resolver for managed subscriptions. JOIN/direct booking stay unchanged.
- Sources: `scripts/nodered_subscription_create_preflight_nodes/` are function-body
  fragments applied by `scripts/patch_live_subscription_create_preflight.mjs`.
- Availability checks reuse `src/components/games/splitSubscriptionAvailability.ts`:
  status, expiry, remaining visits/minutes, studio/type/direction restrictions, and NEW
  first-use handling. The builder pins the helper SHA and TypeScript 5.9.3, embeds the
  compiled helper, and rejects runtime imports. Node-RED gains no dependency.

## Behavior

1. Before exercise creation, authenticate the client and fetch the complete subscription
   list using that client's authorization. Bind the exact selected subscription and
   prospective target to the server CREATE context and operation ID.
2. Check existing availability rules, daily conflicts and, when already enabled, managed
   policy. The prospective target is not an existing exercise or proof that Viva will
   accept the later booking.
3. Stop before Mongo operations. Permit reads and only the existing semantic read-only
   POST to the exact configured `/internal/subscriptions/runtime-context` endpoint.
   Block provider booking, entitlement/activation and database writes during preflight.
4. On a bound success, create the exercise once and run the original gateway again with
   the actual exercise. Preflight never sets `subscriptionGuardDone` or activates rules.
5. Preserve original errors and pending results after creation; add the exact exercise ID
   and `reconciliationRequired` for an owned exercise. Do not introduce automatic deletion.

Expiry/eligibility errors, known daily conflicts and configuration failures now stop
before occupying the court. This does not eliminate every orphan: availability can
change between preflight and booking, and a provider/network failure after CREATE still
needs reconciliation. A GET-empty then unconditional DELETE can race another booking;
no provider atomic empty-only deletion contract has been established. Existing ordinary
payment compensation is outside this change. Historical empty exercises are untouched.

## Local verification and candidate preparation

All raw flows/artifacts remain private and outside Git. Freshness, origin, exact flow SHA,
function-only change budget, wire/link integrity and private output paths are enforced.
A changed live baseline requires a new review; do not relax guards to force application.

```sh
bash scripts/pull_nodered_source_from_147.sh /private/tmp/subscription-preflight-live-UNIQUE
node scripts/check_subscription_create_preflight.mjs /private/tmp/subscription-preflight-live-UNIQUE
node scripts/patch_live_subscription_create_preflight.mjs \
  /private/tmp/subscription-preflight-live-UNIQUE \
  /private/tmp/subscription-preflight-candidate-UNIQUE
```

The acceptance command requires a fresh exact fixture. Direct `node --test` without
`LK_SUBSCRIPTION_CREATE_LIVE_FIXTURE` skips private-fixture cases: this is NOT_RUN,
not runtime acceptance. The builder only writes a full local `candidate.json` and a
redacted `report.json` in a new external 0700 directory (0600 files); it does not import,
restart, deploy, create bookings, debit subscriptions or mutate a database.

Tests cover pre-create reads, daily rejection, malformed/incomplete lists, target/operation
binding, expired/frozen/refunded/unavailable subscriptions, NEW first-use, Piter/HUB
compatibility, resolver POST, blocked activation/Mongo writes, real-exercise revalidation,
late failures, JOIN compatibility, source drift and artifact custody. Managed-policy
success includes an injected accepted decision; full live policy/provider behavior is
NOT_RUN. Local function replay uses fixture responses and is not a physical integration test.

## Release and recovery boundaries

Before any eventual deployment: refresh exact live identity and inspect the three-function
diff from the committed builder, preserve a private exact preimage through the established
reviewed-flow deployment workflow, and obtain the separate stage authorization. This
packet is not an instruction to use broad legacy flow import or deploy a dirty checkout.

Rollback would restore only the authorized exact preimage through that workflow after
checking for intervening drift. It requires separate approval and would restore the old
orphan risk. Do not delete or repair historical exercises as a rollback side effect.

After an authorized deploy, verify loaded function hashes and original success/error
contracts. Real booking/debit/cancellation tests require their own explicit target authority;
without them provider and rendered end-to-end proof remain NOT_RUN.

## Checkpoint evidence

- Fixture-required acceptance: 31 PASS, 0 FAIL, 0 SKIP.
- Subscription/split/leave/roster/patch/modular regression set: 312 PASS, 0 FAIL,
  1 pre-existing optional fixture case SKIP.
- `npm run lint`: 0 errors, 387 existing warnings. Final added tooling scoped lint PASS.
- `npm run build`: production + dev bundles and TypeScript PASS with inert `ci.invalid`
  configuration. These bundles are local checks, not release artifacts.
- Modular extraction/validation of original live LK Games tab: 315 nodes, 38 HTTP inputs,
  0 broken wires/links. Patched full-flow builder independently verifies unchanged
  topology: 4,768 nodes, 215 routes, exactly 3 changed `func` fields.
- Final candidate SHA256: `2144b5838f6c701751f5cc221e998aa1880a320c8153812529bb6b93a23c6c8d`.
- Independent payment/reliability and release/custody reviews: no remaining blocking
  findings. No actual provider write, deployment or historical record repair.

Changed files: this runbook; `docs/WORKLOG.md`;
`scripts/check_subscription_create_preflight.mjs`;
`scripts/patch_live_subscription_create_preflight.mjs`;
`scripts/tests/subscriptionCreatePreflight.test.mjs`;
`scripts/nodered_subscription_create_preflight_nodes/split_start.js`,
`gateway_target.js`, and `finalize.js`.

# Friendship 2.0 interrupted prewrite recovery

The 12 November incident interrupted the native booking router before its daily
guard acquisition. The handler fix is a separate, coordinated one-function
release. This tool reconciles only the exact Friendship 2.0 product, tenant and
incident creation window, after the fixed flow and paired worker are healthy.

`scripts/recover_friendship2_tdz.mjs` defaults to a read-only dry run. It reads
complete Viva subscription consumption and target bookings/calendars, plus the
exact Mongo operation and daily guard. Existing booking, payment, visit-job or
provider-attempt markers, an owned daily guard, incomplete/stale evidence and
occupied CREATE slots are held. It does not create/cancel bookings, issue
transactions, debit/refund visits, change a guard or send user messages.

The apply uses an immutable private dry-run plan and fresh readbacks. Each
operation has a durable exact backup, followed by majority+j full-preimage CAS
including every root field and root field count. It deliberately rejects the
obsolete LOCAL quote as FAILED / LK1_DAILY_VISIT_CHANGED. The permanent
`incidentRecovery` proof records the actual runtime-interruption cause, prior
state/release evidence, preimage/evidence digests and zero provider writes.
This does not claim that Viva refused a booking or returned a visit.

The existing daily-visit retry protocol permits the SAME operation ID to enter
fresh authenticated subscription, target, usage and pricing checks. It excludes
the failed old reservation from allowance; no original free decision is replayed.
Existing native bookings are held and reported as already present, without
reopening a stale ID or rebinding it to CONFIRMED. Actual booking restoration and retry availability
must be reported separately. An explicit user retry remains necessary where no
provider booking exists; the tool cannot impersonate the user's Bearer session.

Run the committed, reviewed source from a private staged packet on server 147:

```sh
node scripts/recover_friendship2_tdz.mjs \
  --output-dir /absolute/private/new-dry-run \
  --incident-end ISO_UTC_FIXED_ROUTER_START \
  --expected-flow-sha256 VERIFIED_FIXED_FLOW_SHA256

node scripts/recover_friendship2_tdz.mjs \
  --output-dir /absolute/private/new-apply \
  --incident-end SAME_ISO_UTC_FIXED_ROUTER_START \
  --expected-flow-sha256 SAME_VERIFIED_FIXED_FLOW_SHA256 \
  --approved-plan /absolute/private/new-dry-run/plan.private.json \
  --approved-plan-sha256 SHA256_OF_THAT_FILE
```

Raw operations, subscriptions, bookings, plans and postchecks stay in protected
0600 files under 0700 directories outside Git. Publish only redacted counters.
This command grants no live-mutation authority: apply requires the user's
explicit incident-recovery authorization. Do not restore old preimages after a
client has retried; a changed record is held rather than overwritten.
Use the optional `--operation-id` on both dry-run and apply to prioritize one
original request. The immutable plan binds that filter; it never broadens apply.

Tests: `node --test scripts/tests/friendship2TdzRecovery.test.mjs`.
Full assembled-router replay additionally verifies CREATE, JOIN and EVENT
same-ID retry, fresh usage, CAS fencing and foreign/effect negatives against
the installed candidate, using private fixtures without sending outputs.

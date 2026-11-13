# Scoped production activation

PR404 is merged as `33929d928cba110186ad1a3e058e18f4eb65b1fa`.
The installed production frontend is a separately maintained composite source,
`9e5bb624b2396b4012b1d3c5cec1564a35180daa`. This release builds from that exact
baseline rather than replacing it with the accumulated frontend changes on main.
All unrelated frontend, exhibition source and the installed PR406 fix are preserved.

The frontend backport carries PR404, the canonical private `client_error` transport
that its emitter requires, and its closed schema/budget dependencies. Installed
dependency versions and integrity records are unchanged. The lockfile restores
49 missing optional platform-package metadata records from the reviewed main lock;
the installed baseline's incomplete lock failed `npm ci` before that correction.

## Collector activation

The actual existing analytics HTTP route fans out directly to its original HTTP
response, Mongo `events.insertOne` and debug. Its old global PATCH observer is a
different deployment and must remain unchanged. Replacing an unloaded core file
does not update this intake.

`scripts/diagnostics/split-leave-collector.mjs` generates one self-contained
Node-RED function from the exact canonical core. It changes only the existing
analytics route's wires and appends that function. For `client_error` with
`SPLIT_LEAVE_INITIATED`, output 1 preserves the original HTTP response message;
output 2 contains a newly built payload-only sanitized envelope for Mongo/debug.
Invalid target diagnostics lose storage only. Other legacy events retain their
existing behavior. This is not a claim that all legacy analytics data is private.

No settings, observer registration, credentials, authentication, provider/business
functions or Node-RED module dependencies change. The native `nodes` deployment
preserves unrelated node instances and requires no process restart.

The collector native operation forks the reviewed function98 custody protocol with
a distinct stage/kind/attempt namespace. It retains the shared root flock, exact
process/disk/code/native-GET/editor-order pins, revision CAS, protected source and
candidate, one-attempt durable marker and 900-second soak. A prior expired ordinary
`soaking` lease can hand off only when its candidate is the exact current source;
its exact bytes are preserved. Active, foreign native, mismatched and ambiguous
leases remain blocked. Lost ACK means reconcile; there is no automatic replay.

The browser guard forwards only the original authenticated editor XHR with its
native auth hooks. It never reads/copies credentials. The graph comes from a fresh
complete authenticated native GET, preserving all other fields and array order.
Only two non-auth headers are inspected. Native HTTP status/time are captured
separately from the graph audit. Post-ACK native GET plus an actual safe synthetic
analytics persistence check establish runtime behavior; HTTP200/disk alone do not.

Explicit inverse operations prove the same forward contract, pin the exact active
candidate, remove only the appended gate and restore only the old route wires.
They preserve business state, retain one-attempt custody and require a fresh
900-second restored-source soak. Unknown state never authorizes lease deletion.

## Frontend publication and acceptance

After collector acceptance, publish the complete clean/pushed prod build using the
existing guarded immutable `lk-frontend-current` namespace. Freeze all previous
hashes, acquire the existing static lease, stage all 16 assets, switch the symlink,
verify remote/public hashes and manifest cache behavior, then finish that lease.
The standard automatic frontend lane is not used for this critical manual release;
its admission is not bypassed or weakened. DEV/academy/legacy namespaces and nginx
routing stay intact.

Use published bytes in synthetic Chromium/WebKit fixtures. Block/mock all business
mutations including `/split/leave`; permit only the existing anonymous analytics
POST after validating its envelope and lack of auth/cookies. Read Mongo by the exact
random `diagnosticEventId`, compare the full stored safe envelope and verify the
trace, server ingest time and absence of private sentinels/arbitrary fields.
No real customer join, leave, booking, payment or notification is needed.

## Coupled cancellation worker

If the cancellation worker is active, stop it gracefully and require PID0/drain
before changing the graph. The user separately authorized this coupled service
update after MAX made it active during this rollout. Its configuration, tenant,
cohort, cursor, permanent auth and every pending intent/job remain untouched.

The pure `collector-worker-rebind.mjs` follows the existing MAX worker preparation
contract. It verifies the complete 13-file public bundle, trusted manifest/guard
hashes, old full-flow pin and unchanged gateway. It derives the new native disk
hash only from the same pinned collector candidate. Exactly 64 digest bytes in
the guard change; the other 12 payload files stay byte-identical. Prepare forward
and inverse artifacts before stopping, retain previous generations, and never
edit an installed hash or accept an arbitrary observed replacement hash.

Keep the worker stopped through the full 900-second backend observation. Before
switching `current`, require actual disk/native graph equality and the prepared
native byte hash; verify the immutable bundle/dependencies and unchanged unit,
configuration and cursor scope. Perform the native generation readiness checks
before starting with the original mode. Observe a complete 120-second cycle and
15 minutes. Do not use SHADOW/once as a read-only probe, replay cancellations,
rewind cursors, clear REVIEW, or change the retained auth module in settings.

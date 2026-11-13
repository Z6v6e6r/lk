# Restore cancellation after a native backend deployment

This release completes merged #392/#397 on147 and restores the existing
`lk1-unpaid-cancel.service`. It preserves its13-file business payload, unit,
dependencies, permanent flow-read auth, mode, tenant, cohort and scan cursor.
Only the two exact backend router functions and worker generation attestation
change. MAX and unrelated Node-RED functions remain untouched.

The worker accepts a flow persisted after PM2 startup only after two authenticated
Admin GETs establish exact active/disk equality and a stable revision, with the
unauthenticated booking route returning its expected401 between those reads.
Exact whole-flow/gateway hashes and service binding remain mandatory. Its initial
finite, nonfuture disk mtime is fixed before asynchronous attestation begins;
any later timestamp, bytes, binding or process change fails closed. The timestamp
is never refreshed by `check()`. This avoids restarting unrelated startup jobs.

Keep the worker stopped through backend preparation, one scoped native deploy and
the full15-minute observation. The expected worker pins are prepared from the
exact candidate graph using Node-RED4.0.9's configured pretty storage encoder
(`JSON.stringify(flows,null,4)`, no trailing newline). The preparer's two-space
JSON is not the disk-byte pin. After native deployment, require the ACTUAL disk
SHA and gateway SHA to equal these committed expected pins, and independently
verify active/disk equality. A mismatch stops activation; it never permits
editing a pin on the host. Build and verify the immutable bundle from clean
pushed source and preserve the old release referenced by settings.

Before start, verify unchanged env/tenant/cohort/cursor scope, fresh INTENT/REVIEW
and free-pending inventory, dependency inventory, installed unit and credential
binding. Use no worker modes or entrypoints as read-only probes: SHADOW advances
cursor and --once can cancel. Start the configured service only after the final
readiness attestation and atomic guarded current-pointer switch. Observe at least
one full120-second cycle and15minutes; claim a natural cancellation only when its
confirmed outcome is observed. An empty due cohort is not an end-to-end test.

Recovery: stop and wait for PID0, preserve every intent/job/cursor and restore the
exact previous current pointer only while stopped. Do not start the old worker
against a new flow, rewind cursors, clear REVIEW, replay ambiguous cancellations,
or roll back unrelated backend releases. Native backend inverse recovery follows
the independently guarded source/candidate generation protocol.

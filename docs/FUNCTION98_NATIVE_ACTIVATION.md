# Function 98: guarded native activation without restart

This is a preparation/review deliverable. It does not authorize its own merge or
production execution. PR #353 supplies the pinned, credential-free warning patch.
The ordinary reviewed-flow apply restarts Node-RED; this operation instead seals
one **native editor Deploy modified nodes** request and preserves every other
node and field. No inject is called, schedule changed, provider probed, process
restarted, or live file written by the controller.

## Authority and custody

The root controller never calls `/flows` and never reads browser credentials.
An existing authenticated Node-RED editor session supplies the original XHR.
Its Authorization/cookie handling remains in the editor's normal AJAX setup;
the guard inspects only the API-version and deployment-type headers. Anonymous
loopback on 147 returned 401 during read-only preparation. There is no anonymous
fallback, token argument, token copy, auth change or permission widening.

Operator/native browser evidence is an explicit provenance attestation, as in
the existing MAX custody protocol; a JSON artifact alone is not cryptographic
proof of an authenticated request. Use a dedicated agent tab with a verified
existing tunnel from `http://127.0.0.1:18801` to server 147 port 1880. Do not
change system routing or the user's tab. Login must be complete before arming.

Every controller CLI action runs under the existing global deployment flock.
The shared lease path is unchanged. Function98 uses **formatVersion 4**, kind
`function98-native-nodes`: old generic and MAX helpers reject it, even after its
deadline. It never automatically expires or becomes an ordinary rollback lease.
Existing active/unknown/editor leases are retained. Only an expired v2 soaking
lease whose candidate hash equals the exact current source may be handed off;
its bytes are durably backed up before the v4 lease replaces it.

## Source and stage preparation

Use a clean, pushed and reviewed helper commit, with matching successful CI.
Compare its five-file code hash locally and remotely; do not execute files from
a dirty checkout. Stage only these source files, preserving repository-relative
paths:

- `scripts/lib/function98_safe_diagnostic.mjs`
- `scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs`
- `scripts/nodered_reviewed_flow_deploy/function98_body_preserver.mjs`
- `scripts/nodered_reviewed_flow_deploy/function98_browser_guard.mjs`
- `scripts/nodered_reviewed_flow_deploy/function98_native_operation.mjs`

The stage is a canonical root-owned 0700 direct child of `/root/.node-red`, named
`.padlhub-function98-stage-YYYYMMDDTHHMMSSZ-<digits>`. Use 0700 subdirectories and
0600 files. Raw source/candidate/plan remain on 147 in this private stage. Never
export them to Git, screenshots, tool output or a local repository.

The entry point is:

```text
node <stage>/scripts/nodered_reviewed_flow_deploy/function98_native_operation.mjs <action> <stage>
```

Actions other than `inspect` consume one JSON object on stdin; no secret values
belong on argv/stdin. `inspect` returns source, runtime-identity and code hashes.
Identity binds root-owned PM2 Node-RED, its listening port, PID/restart count,
machine, executable, command, settings and Node-RED **4.0.9**. Different versions
need a new rehearsal/review, not an override. No change is made to this identity.

## Ordered operation

1. Generate/evaluate the tracked `buildFunction98EditorReadback()` function in
   the dedicated authenticated editor. It performs only native jQuery GET
   `/flows` v2 and returns `{origin, observedAt, revisionSha256, graphSha256}`.
   Do not return the native response, graph, revision, headers or tokens. A 401,
   unexpected origin/shape or missing auth is a no-write prerequisite failure.
2. `prepare` consumes `expectedSourceSha256`, `expectedTargetSha256`,
   `expectedCodeSha256`, the reviewed 40-hex `sourceCommit`, and that fresh
   `native` object. It validates the one-function patch and exact graph contract,
   then fsyncs private source/candidate/plan files. Save the safe returned
   `planSha256`; it binds all later actions. This stage does not reserve a lease.
3. `reserve` consumes `expectedPlanSha256`, fresh PRE `native`, and confirmation
   `RESERVE_FUNCTION98_NATIVE_NO_RESTART_147`. The plan must be at most 30 minutes
   old. It writes the durable reservation receipt and shared v4 lease. It writes
   neither live graph nor process state.
4. `begin` consumes `expectedPlanSha256` and fresh PRE `native`. It exclusively
   writes the durable one-attempt marker and guarded browser source, returning
   a safe `seal` and browser-code hash. Evaluate the exact staged browser guard
   with that seal; verify its hash. The seal is valid for five minutes. Web Locks
   plus an origin-local consumed marker prevent reinstall after tab reload.
   Missing capability, storage error, duplicate/expired seal or cancellation
   fails closed. Never clear a consumed marker or reuse a saved seal.
5. In that tab only, mark the editor dirty without editing any graph/config or
   credential (`RED.nodes.dirty(true)`), then use its normal **Deploy modified
   nodes** button. Do not issue a replacement HTTP client request, import a node
   array, click inject, choose full/flows deployment, or retry. The guard accepts
   only the complete exact source or candidate graph with original revision; it
   substitutes the single safe warning if needed. It rejects every other write,
   including `/flow/:id`, `/flows/state`, `/inject/:id` and fetch mutations. Any
   unrelated editor serialization delta is refused, not normalized or restored.
6. Record only safe guard `status()` audit and native HTTP status/time. Obtain a
   fresh readback after native ACK. `confirm` consumes `expectedPlanSha256`,
   `native`, `audit`, `httpStatus:200`, and epoch-ms `ackAt`. It binds the one
   attempt, source/candidate/revision hashes and deadline; verifies the exact
   disk graph and unchanged runtime identity; and writes ACK before starting a
   full 15-minute soak. Native v2 HTTP ACK precedes asynchronous runtime start:
   it is not itself proof of a running function. Observe normal runtime status
   and errors during the soak without invoking a provider or inject.
7. After the full soak, `finish` consumes `expectedPlanSha256` and a new POST
   `native` observation obtained after expiry. Disk serialization, native
   revision/graph and runtime identity must still match ACK. Receipt is fsynced
   before lease removal. A receipt-only retry after unlink is verified and safe.
   Close the dedicated tab only after reconciliation; keep private stage evidence.
8. Observe the next **natural** cron tick and analyze logs server-side. Require
   the constant diagnostic, no credential-shaped URL/query in this emitter's new
   logs, and unchanged scheduler. Do not reinterpret absence before the scheduled
   tick as proof. At 12 November preparation the next daily 12:20 Moscow tick
   was 13 November, 09:20 UTC. Old logs are not cleaned by this operation.

## Ambiguity and recovery

No controller action sends or repeats a POST. `reconcile` is read-only with respect
to live graph/process and never releases the lease. It reports PRE/POST/UNKNOWN
using fresh native evidence plus disk/runtime identity. A recognized interrupted
publication hardlink may be reconciled only for this operation's own v4 lease;
foreign/arbitrary aliases are refused. `abort` is permitted only before any
attempt marker, with exact PRE state and a durable receipt. Repeated abort after
lease removal verifies the same receipt and PRE state.

After an attempt, even PRE or HTTP 409 does not authorize abort or automatic retry.
Retain custody for owner decision. If the outcome was POST but ACK was lost,
explicit `adopt` requires `expectedPlanSha256`, fresh exact POST `native`, its
`expectedRevisionSha256`, and confirmation
`ADOPT_OBSERVED_FUNCTION98_POST_NO_REPLAY_147`. It records **observed-post-adoption**,
not a fabricated HTTP acknowledgement, and starts a new full soak without POST.
It can reuse a matching durable ACK after a crash. Unknown graph, runtime drift,
wrong revision/code/plan, malformed evidence, or unrelated lease stays blocked.
Do not manually delete the shared lease or restore the leaking warning. An
unresolved PRE/UNKNOWN attempt needs a separately reviewed owner recovery action.

## Verification and limits

Synthetic tests cover one-statement scope, stale/unknown revisions, native auth
preservation, other admin-write refusal, cancellation/reload, lease compatibility,
partial publication recovery, 409, ambiguous delivery/adoption, freshness/drift,
soak and receipt-only completion. A real isolated Node-RED 4.0.9 fixture verifies
unchanged inject and HTTP-node instances, zero startup provider calls, the safe
warning and stale-revision 409. It uses a local fake provider; no real Bitrix call.
CI installs this test-only pinned runtime outside the repository; no application
dependency/lockfile is changed. The existing MAX/default deploy code is unchanged.

Real authenticated editor integration and production execution remain separate
activation evidence. Do not claim this Draft PR has applied the patch to 147 or
verified the future natural run. Credential validity, historical log readers,
rotation and cleanup remain outside this operation.

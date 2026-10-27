# Native editor pause: protected operator operation

This source package prepares the reversible pause of exactly the two existing MAX
injects `e75785ffa19c2e20` and `c1ecd06ce451751b`. It does not authorize execution.
An approved operation must identify the sealed packet SHA, host `lk-primary-147`,
source/native revision, PM2 identity, exact predecessor lease, staging directory,
and the single native editor deploy. Adapter installation, TLS changes, queues,
messages, PM2 restart, drain and rollback are outside this operation.

`editor_pause_operation.mjs` is the only operator entry point. All its actions run
under the canonical reviewed-flow deployment flock. It invokes the canonical
helper in process, so the deployment lease token stays in protected server memory
and the existing root-only lease. No token is printed or supplied in argv, stdin,
browser JavaScript or a second credential file.

## Admission and staging

Before requesting live approval, prepare `operator-packet.json` with the exact
closed key set enforced in the controller and record its SHA256. Use fresh read-only
evidence for machine-id SHA, executable, process cwd/cmdline SHA, PM2 executable/cwd,
settings-file SHA, PID/restarts, graph hashes and authenticated native revision SHA.
Never copy settings contents, PM2 environment, raw native revision, or credentials.
The browser endpoint is fixed to `http://127.0.0.1:18801/flows`, tunneled to the
same target's loopback port1880. A fresh authenticated native GET must match the
server graph and revision pins before `begin`; an HTTP200 alone is insufficient.

After exact approval, stage only the five controller/source modules and the packet
in the approved `.padlhub-reviewed-flow-stage-YYYYMMDDTHHMMSS+ZZZZ-N` directory
directly under `/root/.node-red`. Directory mode0700, files root:root0600, regular,
single link, no symlinks. Pin all five file hashes and the generated browser script
hash in the packet. Do not stage live graphs on the workstation.

Invoke the entry point as `node <stage>/editor_pause_operation.mjs <action> <stage>
<packet-sha256>`. Actions `begin`, `acknowledge`, `finish` and `reconcile` accept a closed safe
JSON observation on stdin. Other actions have no stdin payload. No action accepts
a lease token. Redirect only safe status output to the operation receipt folder.

## Exact sequence

1. `prepare-reserve`: validate the server/process/source, build and seal the
   two-flag candidate, and reserve through the canonical helper. An existing lease
   is admitted only when the packet pins its exact bytes, owner and candidate,
   it is expired v2 `soaking`, and its candidate is the current source. Source,
   contract, candidate and predecessor backups are durable before atomically
   replacing v2 with v3 under the same global flock. There is no unlink gap.
2. In a dedicated normal authenticated editor tab, obtain a fresh native GET and
   select only the two inject disabled flags using normal UI. Select modified
   nodes; do not deploy yet. Check the GET against the sealed full graph/revision.
3. `begin`: supply the safe native observation (UTC time, origin, revision SHA,
   code-point graph SHA, count). Require at least six minutes of reservation time.
   A durable exclusive `browser-attempt.json` grants one five-minute attempt and
   binds packet, contract, lease-token hash and generated guard hash. The emitted
   seal has no auth material. Repeating `begin` fails even if no request was sent.
4. Install the exact generated `browser-guard.js` in the default top-level page
   realm, using the in-memory source graph from the native GET and emitted seal.
   Verify its SHA and safe ARMED status. Use the existing native XHR credentials;
   do not read storage/Authorization or create an authenticated HTTP client.
   Click the normal Deploy button once. The guard restores only the omitted
   `requestTimeout="15000"` field and rejects every other unintended difference.
5. `acknowledge`: require HTTP200, exact guard audit, one forwarded request, fresh
   authenticated native candidate readback/new revision, matching disk graph and
   unchanged process. The controller writes the closed 14-field private ACK and
   invokes canonical confirmation. The full 900-second soak starts then.
6. `finish`: after the entire soak, supply another fresh native observation with
   the same post-revision and graph. The controller writes the protected
   observation and invokes receipt-before-release canonical finish. Close the
   dedicated instrumented tab after successful reconciliation. Keep the user's
   original editor tab unchanged.

## Ambiguity and recovery

Never replay the browser deploy after timeout, disconnect,409, or an unknown ACK.
`reconcile` requires fresh native and disk agreement for PRE/POST; stdin `null`,
missing/stale native evidence or any disagreement returns UNKNOWN with a separate
diskState. It never releases a lease or retries.
PRE after a recorded attempt does not establish that an in-flight request cannot
finish later. The controller therefore refuses automatic abort/release whenever
the attempt marker exists, including a source graph still on disk.

`abort-before-attempt` may release only a matching v3 reservation with the exact
source/process and no attempt marker. It never restores a graph or enables polls.
`recover-confirm` revalidates the already durable ACK through the canonical helper;
`recover-finish` revalidates the already durable observation/finish receipt. These
actions repeat only local reconciliation, never the native UI request. An expired
unconfirmed reservation or unknown graph remains under owner custody.

Actual CDP detach is not covered by the synthetic browser rehearsal. The guard
keeps its one-shot closure and wall/monotonic expiry in the page; no intercepted
request is paused or released when the control connection disappears. Previously
started MAX work may still complete after pollers pause; this is not drain proof.

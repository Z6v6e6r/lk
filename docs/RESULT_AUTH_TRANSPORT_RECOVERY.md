# Result profile transport failure

Owner: LK Games result authentication. Audience: cabinet result readers and
authenticated result writers. The change closes a failed profile verification
with `503 RESULT_AUTH_SERVICE_UNAVAILABLE` and `Cache-Control: no-store`, without
reaching a result read/write branch or retrying a request.

The shared hop serves GET result state, POST submit/confirm/dispute/revert/
accept-correction/expire/session-open and PATCH session-update. CUP JWT remains
opt-in for state; other callers retain Viva profile verification. The existing
prepare and resolve functions, successful actor binding, 401/403 behavior and
ownership checks are unchanged.

## Graph

`Prepare result actor authentication` now sends its first output through
`Bound result profile request` (an unconditional 10,000 ms request budget) to the
existing HTTP verification node. The HTTP node retains `senderr=true`: a core
transport error emits to Catch and suppresses its normal output.

A Catch scoped exclusively to that HTTP node routes to
`Close result profile transport failure`, then directly to the existing result
HTTP response. The sanitizer emits a new envelope containing only req/res,
message correlation, static headers and a static error body. It drops the
upstream error/body, outbound headers, auth context and any pre-existing verified
actor, and removes inbound authorization/integration headers (including raw
header entries). It does not emit to the normal resolver, Mongo or debug nodes.

The constructor uses the same three node definitions as the focused candidate
builder. The legacy wide constructor remains unsuitable for production release.
The original CUP candidate packet remains pinned to its original preimage;
this fix does not repurpose it or relax its guards.

## Candidate preparation, without activation

The focused builder consumes a freshly verified private external workspace:

```sh
node scripts/build_result_auth_transport_candidate.mjs \
  --workspace /absolute/private-live-workspace \
  --out-dir /absolute/new-private-candidate-directory
```

It checks the complete reviewed prepare/request/resolve/response node preimages,
enabled Games tab, all nine authenticated routes, exact auth predecessors,
duplicate/missing references, ID collisions and overlapping Catch scopes. Other
nodes remain byte-for-byte equivalent as JSON values. Only prepare wiring changes;
three nodes are added. Any relevant drift fails closed for a new review.

The builder only writes private local candidate/report files (0700 directory,
0600 files). It never imports, applies, reloads or restarts anything. Source and
candidate flows may contain private configuration and must never enter Git or a PR.

Local fixture checks also exercised the exact incident flow with SHA256
`4a0c338efb6ef3b56d3dd02cc1a7fe4b665f683eede8c66a1dd571bae1e58b39`:
4,985 source nodes become 4,988, with no auth function-body changes. This is
historical evidence. Before a future authorized activation, pull and verify a
fresh live workspace and recheck the focused preimages. Do not substitute the
historical snapshot for a release preimage or rebuild over intervening releases.

## Verification and stop conditions

```sh
node --test scripts/tests/resultAuthTransport.test.mjs
node --experimental-strip-types --test scripts/tests/resultLifecycle.nodered.test.ts \
  scripts/tests/resultSession.nodered.test.ts scripts/tests/resultAuthCupCandidate.test.ts
```

The graph harness runs committed function bodies with an isolated HTTP test
double implementing the core senderr/Catch contract; it makes no provider/DB
calls. It reproduces the old unanswered path and verifies refusal, timeout and
connection reset across all nine routes, exactly one terminal response, no writes
or retries, request envelope preservation, redaction, malformed/no-context error,
valid CUP/Viva identities and unchanged invalid-token/spoof rejection behavior.
The CI authenticated-route step includes the transport suite.

The isolated runtime suite uses the real Node-RED 4.0.9 HTTP Request, Function,
Catch and HTTP Response nodes. It runs the same guarded fixture and committed
function bodies; only the dependency destination and result terminal are local
fixtures. A socket guard permits only the two ephemeral loopback fixture ports,
inherited HTTP proxies are removed in the test process, and no DB nodes exist.
The original graph leaves a real refused request unanswered. The corrected graph
closes refusal on all nine routes, reset on both profile sources and actual
10-second timeouts. Both slow stubs attempt a late response after 12 seconds;
terminal-input/HTTP-finish counters are checked again to exclude a second 503 or
entry into result processing. Valid, invalid-token, malformed-profile and foreign
actor controls exercise the real normal mapper too.

```sh
NODERED_RUNTIME_ROOT=/absolute/isolated-node-red-4.0.9 \
  node --test scripts/tests/resultAuthTransportRuntime.test.mjs
```

CI runs this suite beside the existing pinned 4.0.9 lifecycle check without adding
a project dependency. Optional `RESULT_AUTH_RUNTIME_EVIDENCE` must name a new
local file; only counters, timing and source hashes are written, after all 24
subtests and runtime cleanup succeed. No raw URLs, request bodies or credentials
are exported. This covers isolated core runtime behavior; it does not exercise
external TLS/provider services or production integration.

This change does not establish that the single historical result 504 came from
either recorded ECONNREFUSED. Request-level historical correlation remains unknown.
It also does not remove the independent ph-admin backend stop/start availability gap.

Stop a future rollout for any preimage/Catch overlap, unexpected route/source
change, duplicate response, weakened actor check, exposed credentials or failed
negative tests. No merge, deploy, production request/replay, data mutation or
restart is part of this PR. After a separately authorized activation, observe
natural result/profile traffic and safe phase/terminal aggregates; do not induce
a production dependency failure. A normal 200 alone does not exercise the error
path.

Rollback requires separately authorized scoped restoration against the exact
then-current flow, retaining intervening foreign changes. Restoring this change
also restores the old hanging failure mode; treat rollback as temporary recovery,
not closure of the underlying defect. Never roll back auth flags, data or tokens
as a side effect.

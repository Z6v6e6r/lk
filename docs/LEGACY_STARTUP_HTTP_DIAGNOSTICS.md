# Legacy startup HTTP observation candidate

Owner: Node-RED backend. Audience: operators diagnosing the legacy startup JSON
warning. The historical log named 14 same-name HTTP candidates; only one was
enabled in the inspected graph. This candidate instruments **that one exact node**
without claiming it already proves the historical event's runtime identity or cause.
Onboarding diagnostics and the other 13 HTTP nodes are outside this change.

`scripts/prepare_legacy_startup_http_diagnostics.mjs` exports the pure offline
`composeStartupHttpDiagnostics(sourceBytes, deploymentId, { expectedSourceSha256 })`.
Six exact identity/preimage hashes pin the HTTP node, builder, manual/startup
triggers, debug consumer and tab. Every target must remain enabled on the same tab.
The source hash is independently reviewed. All added IDs must be absent.
Any existing catch on that tab stops composition for error-routing review.

The only existing-node change is the HTTP output wire. A response observer forwards
the **same message object** to the existing debug consumer. A catch scoped solely
to the HTTP node sends transport errors to a terminal observer. No request method,
URL, headers, payload, `ret=obj`, authentication, token cache, trigger, redirect,
timeout or retry setting changes. The existing debug node is not enabled or widened.
The catch adds an error-handling endpoint rather than a business retry or forwarding
path; default error logging may become handled. No pre-existing catch is displaced.

The resulting private `exact-graph` contract uses the existing contract builder and
validator. Its receipt is hashes/counts only; raw candidate and contract files belong
in a private external release workspace, never in Git or a PR. There is no import,
installer, dispatch, restart or provider call in this module.

## Safe observations

Both function bodies use a fixed event code/component, observer version, static
HTTP identity hash and configuration-source fingerprint. Dynamic fields are only:

- stage (`response` or `transport_error`);
- integer HTTP status 100–599, otherwise null;
- Content-Type class derived from media type before parameters;
- observed payload kind, coarse string/buffer length bucket and conservative decode
  outcome; object response size remains unknown without serializing it;
- error-present boolean and allowlisted timeout/DNS/connection/TLS/other class;
- bounded prior-window suppression count.

No request/message/user identifier, body, raw header, URL/query, provider code text,
error message/stack, account value, token or hash of a token is emitted. Logging is
limited to 10 details per 60 seconds **per observer node**, without timers. Suppressed
counts appear on a later admitted event; an idle node does not force a flush.
Logger/context/metadata errors fail open for response delivery. The error observer
always terminates without retry or external writes.

Node-RED 4.x can place a transport code in `statusCode` without `msg.error.code`;
both are checked against the same fixed allowlist. Catch errors without a code are
classified as `other`; their message is never inspected. A transport failure can be
seen at both stages, so these are event counts, not unique request counts.

An object payload does not imply business success. A string after `ret=obj` can be
a parse failure or a valid JSON string result: it is explicitly ambiguous. Status,
format and node identity are evidence for the next investigation, not a guessed root
cause. The observer does not turn the existing JSON warning into a successful result.

## Validation and activation hold

```sh
node --test scripts/tests/legacyStartupHttpDiagnostics.test.mjs
```

Tests cover exact graph/source guards and collisions; JSON objects/arrays/primitives,
HTML, malformed/string JSON, empty/204, redirect and buffers; transport DTOs;
Content-Type parameters; no private-value exposure; payload identity; bounded logs;
context/logger failures and avoiding provider-object serialization/coercion.
The existing CI Node-RED fixture step also runs the legacy-startup test glob.

Before any separately authorized publication, pull and verify a fresh private live
workspace with the existing workflow, compose and review the exact source/candidate
hashes and all affected graph edges. Any drift/catch conflict is a stop signal.
No raw flow is fetched or committed by these tests. Publication and restart are not
authorized by this Draft PR. Observe a future **natural** event; do not force a
refresh, request, booking, notification or restart for evidence. No event means
awaiting evidence, not resolved. Only safe metadata may leave the server.

After activation, check readback against the reviewed candidate and identify which
observer fired. Then propose a separately scoped response guard or retirement;
upstream status/route/root cause remain unknown until evidence exists. Recovery
restores only this diagnostic graph against the approved preimage after a fresh
foreign-change check; it must not overwrite concurrent changes or replay requests.

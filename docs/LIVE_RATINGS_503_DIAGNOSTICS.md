# Live ratings 503 diagnostics

Owner: LK Games backend. Audience: operators investigating failed batch-rating reads.
The canonical route is `POST /lk/games/ratings/live`; the POST method carries a
batch read. This change only adds structured warnings to its existing token
failure branches. It does not identify the cause of historical 503 responses.

## Event contract

Each application token failure attempts one `node.warn(JSON.stringify(record))`.
The fixed event `code` is `LK_LIVE_RATINGS_503`, `route_key` is
`games_ratings_live`, and `downstream_status` is 503. Native Node-RED log time is
the timestamp; one record represents one rejected request, not one unique user.

| Stage | Reason code | Additional fields |
| --- | --- | --- |
| `token_guard` | `VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS` or `VIVA_SERVICE_AUTH_NOT_CONFIGURED` | `cache_state`: `missing`, `expired`, `within_grace`, `unknown`; `lock_state`: `active`, `expired`, `absent`, `unknown` |
| `token_http` | `VIVA_SERVICE_AUTH_UNAVAILABLE` | `token_http_status`: integer 100–599 or `unknown`; `transport_class`: `none`, `timeout`, `connect`, `tls`, `parse`, `unknown` |

Guard facts use already-read local values. No additional env/context reads,
shared counters, writes, retry loops or timers are introduced. The guard reason
is allowlisted, with `UNKNOWN` for an unrecognised future code. Transport classes
come only from exact allowlisted Node-RED `statusCode` values; an unknown or
decorated string is never copied or substring-matched. A numeric upstream status
takes precedence and has transport class `none`. HTTP 200 without an access token
still produces the existing 503, with `token_http_status: 200`.

No bodies, messages, headers, URL/query, IP, names, phones, user/client/game/request
or node identifiers, credentials, tokens, cache values, owners, exact expiry/lock
timestamps or exception text enter this event. There is no fallback log containing
`msg`. Missing or throwing sinks are ignored and cannot alter the existing result.
Success/cache/refresh-leader paths are silent. This is one bounded record per
failure without shared rate-limiter state; an outage can still increase log volume.

## Preserved behavior

Only `fn_live_ratings_get_token.js` and `fn_live_ratings_store_token.js` emit new
warnings. HTTP status/body/headers, output identity and routing, token form/URL,
environment precedence, 30-second cache grace, 10-second refresh lock, owner
cleanup, GET player lookups, fallback and final batch response are unchanged.
No diagnostic fields are attached to `msg` or returned to the client. Existing
debug outputs are unchanged.

This observes application token refusals only. A proxy/middleware 503 that never
reaches these functions cannot emit the event. Absent events do not prove an
ingress failure or a successful read. Distinguishing that case needs separately
available safe proxy upstream-status metadata. HTTP 200 can still contain rating
fallbacks; this patch does not add player outcome counters or prove live freshness.

## Local verification and release boundary

```sh
node --test scripts/tests/liveRatings503Diagnostics.test.mjs
npm run test:viva-token-cache
```

The focused test uses isolated VM mocks with no network modules. It checks exact
event schemas, arbitrary private markers/transport strings, all three branches,
silence on success, response/output/cache/lock preservation and absent/throwing
sinks. An optional `LIVE_RATINGS_503_PREIMAGE` path enables full before/after
function comparison against the privately held, hash-pinned historical snapshot;
that snapshot is never committed or exported by the test.

No flow/import artifacts are generated for this source-only PR. No API/provider
calls, secret changes, merge, deployment, restart or live mutations are part of it.
Do not use the broad historical token-cache migration patcher to release these
two diagnostics: it also targets unrelated payment functions. A future separately
authorised rollout needs a fresh verified live preimage and a focused reviewed
two-function candidate preserving graph/topology and foreign changes.

Stop signal after a future authorised rollout: any private field in an event or
changed HTTP/auth/cache/lock behavior. Stop method: stop that rollout and use its
reviewed guarded recovery; do not manually patch production. Rollback removes
these two warning blocks against the exact reviewed candidate and restores the
previous function bodies. It does not require secret rotation or business writes.

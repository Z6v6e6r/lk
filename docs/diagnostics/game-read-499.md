# Game read 499 correlation

Owner: LK frontend/infrastructure maintainers. Audience: operators diagnosing game reads.
Source preparation only: no production configuration, deployment or restart is included.

## Scope and identity

Only GET `/lk/games/:gameId` and GET `/lk/games/:gameId/result/state`, on the configured
SERV2/SERV2_FALLBACK origins, receive diagnostic headers. List/action literals, other
origins and methods are excluded. `VITE_GAME_READ_DIAGNOSTICS=true` opts in at build time;
default is off. Each physical fetch attempt gets its own CSPRNG UUIDv4, including retries
and fallback attempts. A cached/deduplicated call need not create a fetch. Missing crypto
leaves the business request usable without correlation. Caller-supplied reserved headers
are replaced or removed; Authorization, cache options, body, URL and AbortSignal are retained.

- `X-LK-Client-Request-ID` equals the browser error event's `requestId`.
- `X-LK-Client-Build` is the immutable bundle source SHA or `UNKNOWN`. Cabinet, games and
  communities Vite configurations compute it from a clean Git tree; dirty builds are UNKNOWN.
- Existing response `X-LK-Request-ID`, `serverRequestId` and `serverLinked` keep their meaning.
- Browser `correlationAttached=true` means the header was prepared, not that Nginx received it.
  DNS/preflight failures, local cache and pre-aborted signals may have no matching edge entry.
- IDs/build from a browser are untrusted diagnostic claims. Validation bounds their shape;
  it does not authenticate them. They never authorize, deduplicate or drive retries.

The two new request headers can introduce CORS preflight for previously simple reads. They do
not change the URL/cache key, add Vary, or invalidate ETags/304. The gateway must accept them
before the frontend option is enabled. The origin guard checks the initial destination; standard
Fetch redirects can retain custom headers. These API reads must not redirect to an external origin;
verify this gateway contract before activation. No redirect behavior is changed by this source.
Browser already knows its ID: no new response echo or
Expose-Headers is required. The gateway strips both new headers before the Node-RED upstream,
so they cannot accidentally propagate into provider calls.

## Data and interpretation

`lk-game-read-diagnostics-http.conf` is an http-context fragment. The separate JSONL format has
schemaVersion, source, serverTime (ISO8601 including timezone), a server-generated edgeRequestId,
validated clientRequestId/callerBuild or UNKNOWN, fixed routeTemplate, method, status, bodyBytes,
requestCompletion, requestTimeSeconds and upstreamConnect/Header/ResponseTimeSeconds/upstreamStatus.
Times use seconds. Upstream values stay strings: `-` means unavailable; retries/multiple upstreams
may produce several values. Missing time is never converted into zero. Request time is measured
by Nginx, not inferred from neighboring access-log timestamps.

The format excludes IP, User-Agent, Referer, raw URI/query, game/business/session IDs, bodies,
Authorization, credentials and arbitrary error text. Existing canonical/support logs are preserved;
this does not sanitize their historical data. New events use the existing strict allowlist,
PII-free analytics envelope, delivery budget and queue; they do not export legacy raw envelopes.

The browser error contains monotonic `durationMs`, `callerBuild`, requestId, routeTemplate and
`abortCause`: deadline, scope_disposed, explicit_cancel, or unknown. Only the actual signal reason
can establish a labelled cancellation. No controller, timeout, cancellation or retry is added.
Navigation is not inferred from elapsed time, TypeError, AbortError or scope disposal. For these
GETs, an unlabelled browser/network cancellation remains unknown. Future callers may pass a reason
only at the actual cancellation boundary. Reasons are never arbitrary signal.reason text.

Abort cause arrives in a separate browser event after failure; Nginx cannot put that future fact
into its original 499 line. Join browser.requestId to edge.clientRequestId. Multiple claims or
replays remain ambiguous; edgeRequestId distinguishes edge records. Request completion/499 does
not establish business outcome. If the page closes/offline prevents telemetry delivery, reason
remains unknown. Delivery budgets/suppression also limit detailed correlation. Events without a
matching edge entry must not be reported as a confirmed 499.

## Offline candidate and future activation

`prepareGameReadDiagnostics(source, expectedSha256)` in
`scripts/nginx/prepare_game_read_diagnostics.mjs` is a pure builder, with no apply/reload path.
Input is the privately captured vhost source. Explicit `role: primary|reserve` selects the
existing nested games location or the existing reserve API regex location. Existing proxy routing,
Host/forwarded headers, timeouts and canonical/support logs are retained. When access_log is
inherited, the full closest effective list is materialized locally before adding the diagnostic
stream. If it comes from nginx.conf, pass its exact `httpSource` and `expectedHttpSha256` too.
Ancestor literal includes require an exact hash-bound `includeSources` manifest (including recursively included files); unproven/glob/cyclic includes fail closed. Missing canonical log, unsupported target includes/nested locations, drift, duplicate targets, foreign or
partial instrumentation are rejected. The builder also validates idempotent scope ownership.

Primary strips the two headers before Node-RED. Reserve forwards only validated scoped claims to
primary (UNKNOWN for invalid values), while non-target API requests get neither header. Both reserve
CORS lists (OPTIONS and ordinary responses) are extended; the initial origin/method/access rules
are preserved. Prepare/review the HTTP fragment and both vhosts together.

Dedicated sink policy: install `lk-game-read-diagnostics.logrotate` at
`/etc/lk-game-read-diagnostics.logrotate` and its cron entry at
`/etc/cron.d/lk-game-read-diagnostics`. It uses its own state file and does not overlap the
distribution's `*.log` policy. Hourly evaluation rotates at most 3 archives, maxage 1 day,
maxsize 32MiB; these are rotation limits, not a hard disk quota between evaluations. Maxage cleanup runs on rotation, so idle files do not imply a strict erasure deadline. Both cron
and logrotate must be available. Use restricted 0640 www-data:adm sink ownership and monitor disk.

Future rollout requires separate approval:

1. Capture fresh private primary/reserve config preimages; review selected location and inheritance,
   permissions and an approved bounded retention policy (suggested max 24h/128MiB, whichever first).
   Provision the dedicated JSONL sink with restricted access and rotation before enabling capture.
2. Build a hash-guarded vhost candidate and install the HTTP maps/format through the existing config
   release procedure. Run `nginx -t`, compare configs, preserve exact rollback preimages. No raw
   config/production logs belong in Git or PRs. Never remove existing canonical/support logging.
3. Validate CORS preflight for both headers on every enabled origin, successful and cached GET,
   fixed route selection, header stripping, old clients and diagnostic sink/rotation behavior.
4. Build clean pushed frontend source with the option true, then use its normal release procedure.
   Do not enable an unprepared fallback origin. Until then this PR leaves capture inactive.
5. On natural traffic confirm requestId equality and actual source build, not just timing proximity.
   Stop signal: CORS/read/cache regression, leaked data, missing canonical logs or sink pressure.
   Stop via separately authorized frontend flag-off rebuild/release and exact config restoration;
   never replay business operations or infer historical root causes from new events.

## Checks

```sh
node --test scripts/tests/gameReadCorrelation.test.mjs scripts/tests/gameReadDiagnosticsNginx.test.mjs
LK_TEST_NGINX=/absolute/path/to/nginx node --test scripts/tests/gameReadDiagnosticsNginx.test.mjs
```

The second command starts only loopback synthetic upstream/Nginx processes in a temporary directory.
It exercises a real client disconnect producing 499, edge timing/correlation, invalid/duplicate
claims, CORS, header stripping, existing logs/headers, 304 and 404, and PII sentinels. Without an
explicit binary the runtime case is skipped; source/candidate tests still run in CI. No production
API, browser login, provider, booking or payment is used by the rehearsal.

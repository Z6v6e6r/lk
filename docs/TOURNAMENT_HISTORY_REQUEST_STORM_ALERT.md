# Tournament History Request Storm Alert

## Decision

Do not add this as a frontend analytics event. `src/utils/analytics.ts` is intentionally errors-only for most events, abusive clients may not send client telemetry, and cached `304` responses still hit nginx and the backend route. The minimal reliable contour is backend-side access-log monitoring for:

```text
GET /lk/tournaments/americano/history?tournamentId=...
```

Apply it on `lk-primary-147` first. Add the same log/alert to the reserve gateway only if `/lk/tournaments` traffic is proxied through `lk-reserve-89`.

## Alert Thresholds

Use 10-minute and 1-hour windows. Group identity alerts by `remote_addr + tournamentId`; group route alerts by route only.

| Rule | Severity | Condition |
| --- | --- | --- |
| `TournamentHistoryIdentityRequestStorm` | P0 / page | `>= 1200 requests in 10m` for one `remote_addr + tournamentId`, or `>= 2000 requests in 1h` for one `remote_addr + tournamentId` |
| `TournamentHistoryRouteStorm` | P0 / page | `>= 3000 requests in 10m` for the route, or `>= 15000 requests in 1h` for the route |
| `TournamentHistoryIdentityRequestStormWarning` | P1 / notify | `>= 300 requests in 10m` for one `remote_addr + tournamentId` |
| `TournamentHistoryRouteStormWarning` | P1 / notify | `>= 1000 requests in 10m` for the route |

The 2026-06-28 incident had `38329` requests in one hour from `95.165.157.255` for `tournamentId=6c4d1403-b250-4d96-91bf-b7c1fd99343a`, so it would trigger the P0 identity alert and the P0 route alert.

The 2026-08-17 incident was smaller but still cleared shared Mongo pools: one
localhost-backed test contour produced about `2400` requests in one hour for a
single non-empty history response. The previous warning threshold missed it;
the revised hourly identity threshold catches this pattern.

## Nginx Log Spec

Store the nginx-side config next to host operations snippets, for example `docs/ops/nginx-lk-primary-147.md` or the server config management repo. Keep this repository copy as the source alert contract and validate it with `scripts/tests/tournamentHistoryRequestStormAlert.test.ts`.

Add the log format and map in the nginx `http` block:

```nginx
map $request_uri $lk_tournament_history_loggable {
    default 0;
    ~^/lk/tournaments/americano/history\? 1;
}

log_format lk_tournament_history_json escape=json
    '{'
    '"ts":"$time_iso8601",'
    '"host":"$host",'
    '"remote_addr":"$remote_addr",'
    '"xff":"$http_x_forwarded_for",'
    '"method":"$request_method",'
    '"uri":"$request_uri",'
    '"path":"$uri",'
    '"tournamentId":"$arg_tournamentId",'
    '"status":$status,'
    '"request_time":$request_time,'
    '"upstream_response_time":"$upstream_response_time"'
    '}';
```

Add the targeted access log in the `server` block that serves/proxies `/lk/tournaments`:

```nginx
access_log /var/log/nginx/lk_tournament_history_access.log lk_tournament_history_json if=$lk_tournament_history_loggable;
```

## Loki Alert Rules

Promtail should scrape `/var/log/nginx/lk_tournament_history_access.log` without indexing `remote_addr` or `tournamentId` as static labels:

```yaml
scrape_configs:
  - job_name: lk_tournament_history_nginx
    static_configs:
      - targets: [localhost]
        labels:
          job: lk_tournament_history_nginx
          host: lk-primary-147
          __path__: /var/log/nginx/lk_tournament_history_access.log
    pipeline_stages:
      - json:
          expressions:
            remote_addr: remote_addr
            method: method
            uri: uri
            tournamentId: tournamentId
            status: status
```

Grafana Loki ruler:

```yaml
groups:
  - name: lk-tournament-history-request-storm
    interval: 1m
    rules:
      - alert: TournamentHistoryIdentityRequestStorm
        expr: |
          sum by (remote_addr, tournamentId) (
            count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" | tournamentId!="" [10m])
          ) >= 1200
          or
          sum by (remote_addr, tournamentId) (
            count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" | tournamentId!="" [1h])
          ) >= 2000
        for: 2m
        labels:
          severity: page
          service: lk-tournaments
        annotations:
          summary: "LK tournament history request storm for {{ $labels.remote_addr }} / {{ $labels.tournamentId }}"
          runbook: "Check nginx top IP/tournamentId, temporarily block or rate-limit the identity, then verify Node-RED/Mongo hardening."

      - alert: TournamentHistoryRouteStorm
        expr: |
          sum(count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" [10m])) >= 3000
          or
          sum(count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" [1h])) >= 15000
        for: 2m
        labels:
          severity: page
          service: lk-tournaments
        annotations:
          summary: "LK tournament history route-level request storm"
          runbook: "Inspect top remote_addr/tournamentId from lk_tournament_history_access.log before changing app code."

      - alert: TournamentHistoryIdentityRequestStormWarning
        expr: |
          sum by (remote_addr, tournamentId) (
            count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" | tournamentId!="" [10m])
          ) >= 300
        for: 10m
        labels:
          severity: notify
          service: lk-tournaments
        annotations:
          summary: "Elevated LK tournament history traffic for {{ $labels.remote_addr }} / {{ $labels.tournamentId }}"

      - alert: TournamentHistoryRouteStormWarning
        expr: |
          sum(count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" [10m])) >= 1000
        for: 10m
        labels:
          severity: notify
          service: lk-tournaments
        annotations:
          summary: "Elevated LK tournament history route traffic"
```

## Optional Nginx Guardrail

This is a mitigation, not the alert. Apply only after checking the route's shared proxy/CORS config, because an exact `location = /lk/tournaments/americano/history` must preserve the same upstream headers as the current `/lk/tournaments` proxy.

```nginx
limit_req_zone $binary_remote_addr$arg_tournamentId zone=lk_tournament_history_by_ip_tournament:20m rate=24r/m;

location = /lk/tournaments/americano/history {
    limit_req zone=lk_tournament_history_by_ip_tournament burst=24 nodelay;
    # keep the existing /lk/tournaments proxy headers, CORS handling, timeouts and proxy_pass here
}
```

Recommended response to P0:

1. Confirm the top `remote_addr`, `tournamentId`, status mix, and request rate from `lk_tournament_history_access.log`.
2. Temporarily block or rate-limit the offending identity if the storm continues.
3. Verify backend hardening separately: disable accidental debug fan-out, create an index on `tournaments.tournamentId`, and constrain the history query with `findOne` or `limit`, projection and `maxTimeMS`.
4. Verify frontend hardening separately: explicit-open fetch only, in-flight dedupe, and a short cache for both empty and non-empty history.

## Application Guard Contract

The guarded Node-RED candidate is built by
`scripts/patch_live_tournament_history_storm_guard.mjs` from the exact active
flow preimage. It adds no routes and preserves the existing `limit=1`,
`limit=50`, `maxTimeMS=5000`, and scoped storage-error path.

Before either Mongo read it applies a per `x-real-ip + tournamentId` fixed-window
limit of 24 requests per minute and a shared 10-second response cache. A cache
hit bypasses both Mongo reads. Missing IDs return `400`; excess traffic returns
safe `429 TOURNAMENT_HISTORY_RATE_LIMITED` with `Retry-After`.

The browser also caches every successful production history response for 10
seconds. A page served from `localhost`, `127.0.0.1`, or `::1` cannot call the
production PadlHub history API unless the build explicitly sets
`VITE_ALLOW_LOCAL_PRODUCTION_HISTORY_API=true` in the `dev` release channel.
The override is ignored by a production-channel bundle, is for a bounded,
operator-controlled smoke only, and must not be present in ordinary local or
DEV builds.

Before rollout:

1. Fresh-pull the protected `147` flow and require the exact reviewed SHA.
2. Run the patcher outside the repository and confirm only two existing wire
   changes plus two added function nodes.
3. Verify the live nginx proxy overwrites `X-Real-IP`; do not trust a
   browser-supplied forwarding header.
4. Run a read-only `explain("executionStats")` for the five-field
   `lk_community_feed` publication query. Treat `COLLSCAN` as a separate index
   migration gate; the application guard does not authorize index creation.
5. Load-test two callers every three seconds. Confirm that the shared cache
   bounds serialized storage reads (the focused harness observes four in the
   first minute), requests above 24 receive `429`, and parallel cold misses do
   not cause sustained read growth. The cache is not a distributed singleflight
   lock, so a small burst can still reach storage at a cache boundary.

## Community Feed History Index Migration

The publication fallback reads `games.lk_community_feed` through five `$or`
branches. The 2026-08-17 production preflight found MongoDB `8.0.17-6`, 19,564
documents (about 47 MB logical data), only `_id_`, and a `COLLSCAN` examining
19,564 documents. Of 1,601 active tournament publications, the dominant lookup
field was `details.publicTournament.exerciseId` (816 documents); the remaining
legacy fields were absent or nearly absent. Use five indexes partial on
`kind: "TOURNAMENT"` so every `$or` branch is eligible without indexing the
roughly 18,000 unrelated community posts. Do not add a field `$type` condition:
MongoDB 7 rehearsal kept the resulting `$or` plan on `COLLSCAN` because the
query planner could not prove that partial-filter implication.

The migration tool is catalog-digest guarded and never prints the connection
URI. `plan` and `verify` are read-only. A private Node-RED flow file supplies
the exact reviewed production Mongo config. `MONGO_URI` is accepted for
`plan`/`verify` only with the explicit `CONFIRM_ISOLATED_DB` test-mode guard;
`apply` always requires `--flow-path`.

Create a read-only plan first:

```bash
npm run mongo:tournament-history-indexes -- plan \
  --flow-path /root/.node-red/flows.json \
  --out /root/tournament-history-index-plan.json
```

Review the five missing managed indexes, require zero catalog conflicts, and
record the 64-character `planDigest`. Index creation is a separate deployment
gate: the application storm guard, its rollout approval, and this plan do not
authorize a production write.

After explicit migration approval, apply only the unchanged plan:

```bash
TOURNAMENT_HISTORY_INDEX_APPLY=CONFIRM_LK_COMMUNITY_FEED \
  npm run mongo:tournament-history-indexes -- apply \
  --flow-path /root/.node-red/flows.json \
  --expected-plan-digest <reviewed-plan-digest> \
  --out /root/tournament-history-index-apply.json
```

The apply step creates only missing exact managed indexes and then requires all
five names in the winning plan with no `COLLSCAN`. If that postcheck fails, it
best-effort removes only exact managed indexes absent from the initial catalog
and exits non-zero. Never drop a name/equivalent conflict automatically.

Run the independent read-only postcheck:

```bash
npm run mongo:tournament-history-indexes -- verify \
  --flow-path /root/.node-red/flows.json \
  --out /root/tournament-history-index-verify.json
```

The isolated rehearsal uses MongoDB 7, while production currently reports
MongoDB 8. Treat the production `plan` and post-apply `verify` as mandatory
version-specific gates.

## Backend Rollout Postcheck

Apply the Node-RED import from `node-red/modular/imports-tournaments-active/` before treating the backend route as hardened. The expected history route properties are covered by `scripts/tests/tournamentHistory.nodered.test.ts`: no reachable active debug node, `limit=1`, and `maxTimeMS=5000`.

Create the supporting MongoDB index on the live database:

```bash
mongosh "$MONGO_URI" --quiet --eval '
const dbx = db.getSiblingDB("games");
printjson(dbx.tournaments.createIndex(
  { tournamentId: 1 },
  { name: "tournaments_tournamentId_1", background: true }
));
'
```

Postcheck that a known history lookup uses the index:

```bash
mongosh "$MONGO_URI" --quiet --eval '
const dbx = db.getSiblingDB("games");
const exp = dbx.tournaments
  .find({ tournamentId: "<knownTournamentId>" })
  .limit(1)
  .explain("executionStats");

function stages(plan, out = []) {
  if (!plan || typeof plan !== "object") return out;
  if (plan.stage) out.push(plan.stage);
  for (const value of Object.values(plan)) stages(value, out);
  return out;
}

const found = stages(exp.queryPlanner.winningPlan);
printjson({
  stages: found,
  totalKeysExamined: exp.executionStats.totalKeysExamined,
  totalDocsExamined: exp.executionStats.totalDocsExamined
});
if (found.includes("COLLSCAN")) quit(2);
if (!found.includes("IXSCAN")) quit(3);
'
```

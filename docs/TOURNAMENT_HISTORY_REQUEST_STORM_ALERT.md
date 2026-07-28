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
| `TournamentHistoryIdentityRequestStorm` | P0 / page | `>= 2000 requests in 10m` for one `remote_addr + tournamentId`, or `>= 10000 requests in 1h` for one `remote_addr + tournamentId` |
| `TournamentHistoryRouteStorm` | P0 / page | `>= 5000 requests in 10m` for the route, or `>= 25000 requests in 1h` for the route |
| `TournamentHistoryIdentityRequestStormWarning` | P1 / notify | `>= 600 requests in 10m` for one `remote_addr + tournamentId` |
| `TournamentHistoryRouteStormWarning` | P1 / notify | `>= 2000 requests in 10m` for the route |

The 2026-06-28 incident had `38329` requests in one hour from `95.165.157.255` for `tournamentId=6c4d1403-b250-4d96-91bf-b7c1fd99343a`, so it would trigger the P0 identity alert and the P0 route alert.

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
          ) >= 2000
          or
          sum by (remote_addr, tournamentId) (
            count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" | tournamentId!="" [1h])
          ) >= 10000
        for: 2m
        labels:
          severity: page
          service: lk-tournaments
        annotations:
          summary: "LK tournament history request storm for {{ $labels.remote_addr }} / {{ $labels.tournamentId }}"
          runbook: "Check nginx top IP/tournamentId, temporarily block or rate-limit the identity, then verify Node-RED/Mongo hardening."

      - alert: TournamentHistoryRouteStorm
        expr: |
          sum(count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" [10m])) >= 5000
          or
          sum(count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" [1h])) >= 25000
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
          ) >= 600
        for: 10m
        labels:
          severity: notify
          service: lk-tournaments
        annotations:
          summary: "Elevated LK tournament history traffic for {{ $labels.remote_addr }} / {{ $labels.tournamentId }}"

      - alert: TournamentHistoryRouteStormWarning
        expr: |
          sum(count_over_time({job="lk_tournament_history_nginx"} | json | method="GET" [10m])) >= 2000
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
limit_req_zone $binary_remote_addr$arg_tournamentId zone=lk_tournament_history_by_ip_tournament:20m rate=120r/m;

location = /lk/tournaments/americano/history {
    limit_req zone=lk_tournament_history_by_ip_tournament burst=240 nodelay;
    # keep the existing /lk/tournaments proxy headers, CORS handling, timeouts and proxy_pass here
}
```

Recommended response to P0:

1. Confirm the top `remote_addr`, `tournamentId`, status mix, and request rate from `lk_tournament_history_access.log`.
2. Temporarily block or rate-limit the offending identity if the storm continues.
3. Verify backend hardening separately: disable accidental debug fan-out, create an index on `tournaments.tournamentId`, and constrain the history query with `findOne` or `limit`, projection and `maxTimeMS`.
4. Verify frontend hardening separately: explicit-open fetch only, in-flight dedupe, and negative cache for empty future history.

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

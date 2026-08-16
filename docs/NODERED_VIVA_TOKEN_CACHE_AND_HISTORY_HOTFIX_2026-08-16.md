# Node-RED Viva token cache and tournament history hotfix — 2026-08-16

## Scope

This checkpoint changes only the reviewed Node-RED paths:

- `POST /lk/games/ratings/live`;
- `POST /lk/games/split/create`;
- `POST /lk/games/:gameId/split/join`;
- split-payment cleanup tasks that use the Viva Admin API;
- `GET /lk/tournaments/americano/history`.

It does not rotate credentials, deploy a flow, mutate production data, or change public route names.

## Viva service token contract

The reviewed functions share these Node-RED global-context values:

- `vivacrm_access_token`;
- `vivacrm_token_expires_at`;
- `vivacrm_token_refresh_owner`;
- `vivacrm_token_refresh_lock_until`.

A token is reused only when it remains valid for more than 30 seconds. One caller acquires a
10-second refresh lease; concurrent callers fail closed with retryable HTTP 503 instead of issuing
another password grant. A refresh owner may clear only its own lease. Upstream token errors and
payloads are never returned to the client.

The following runtime variables must be supplied through the protected Node-RED process environment:

- `VIVA_SERVICE_USERNAME` — required;
- `VIVA_SERVICE_PASSWORD` — required;
- `VIVA_SERVICE_CLIENT_ID` — optional, defaults to the currently reviewed client identifier;
- `VIVA_SERVICE_TOKEN_URL` — optional, defaults to the production Viva Keycloak token endpoint.

Values must not be stored in Git, flow JSON, deployment reports, shell history, or CI output.
Missing required variables blocks the affected operation with HTTP 503 and performs no Viva or
local persistence mutation.

## Tournament history resilience

The history lookup remains a read-only chain. The candidate:

- limits the exact tournament lookup to one document;
- limits active community publications attached to history to 50 documents;
- keeps the existing 5-second Mongo deadlines;
- catches errors only from those two Mongo nodes;
- returns HTTP 503, `Retry-After: 5`, `Cache-Control: no-store`, and code
  `TOURNAMENT_HISTORY_STORAGE_UNAVAILABLE`;
- does not expose Mongo error details.

The existing successful response chain is unchanged.

## Guarded candidate generation

`scripts/patch_live_viva_token_cache.mjs` validates:

- the complete input-flow SHA-256;
- exact live node IDs, names, output counts, and reviewed wires;
- the preimage hash of every replaced function;
- unchanged HTTP routes and unchanged non-target nodes.

`scripts/patch_live_tournament_history_resilience.mjs` validates:

- the complete input-flow SHA-256;
- the exact route and Mongo/function chain;
- absence of pre-existing managed limits and catch nodes;
- unchanged HTTP routes and unchanged non-target preimage nodes;
- no duplicate node IDs or broken wires in the candidate.

Both patchers keep the source immutable, refuse existing output/report paths, and create candidate
and report files with mode `0600`. The reviewed default flow preimage is
`d9ae9ef519f5f1e1bc474ebd7aff955b20721af3467c92f079cf6f68dc26c76a`; deployment must stop if the
fresh live flow has another digest.

## Release gates

Before a deployment may be authorized:

1. Pull a fresh live flow from server 147 using the repository runbook and verify its origin.
2. Confirm the live flow digest and targeted node preimages match the guarded patchers.
3. Back up the exact live flow with restricted permissions.
4. Provision the required service variables in the protected Node-RED environment without printing
   their values.
5. Complete a separate inventory of all remaining active password-grant nodes. This checkpoint
   removes the reviewed credential fallback only from the targeted ratings/split/cleanup paths;
   credential rotation is blocked until the broader inventory and cutover plan are approved.
6. Generate both candidates sequentially against the same reviewed preimage or a verified prior
   candidate, then run Node-RED validation and inspect the combined report.
7. Obtain a separate deployment approval under the staged delivery workflow.

## Post-deploy checks

Read-only and synthetic checks must record status/code and timings without tokens or personal data:

- first live-ratings request refreshes once; subsequent requests reuse the cache;
- parallel ratings and split requests do not produce multiple refresh grants;
- split create/join preserve their existing success and subscription-limit behavior;
- missing/invalid service configuration yields safe 503 and no local/Viva mutation;
- history success returns the same response schema;
- induced or observed Mongo timeout returns the bounded 503 response instead of nginx 504;
- PM2 restart count, nginx 5xx/499/504 aggregates, and Node-RED errors remain stable.

## Rollback

Rollback restores the exact backed-up flow and the prior protected environment file, restarts only
the reviewed Node-RED process, and then repeats the same route-specific smoke checks. Do not manually
edit production flow JSON or recreate unrelated containers. Cache values are process-local and are
discarded on restart.

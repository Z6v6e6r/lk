# Game PATCH 409 diagnostics

Owner: LK frontend/backend. Audience: incident investigation. This is source and
fixture-tested preparation; it does not enable production logging or deploy code.

| Field | Source and meaning |
| --- | --- |
| `callerBuild` | Exact clean Git source SHA embedded by cabinet/games Vite configs; dirty/unavailable Git produces `UNKNOWN`. It identifies the executing bundle, not the latest manifest. |
| `logicalOperation` | Fresh UUIDv4 per `apiUpdatePadelGameRecord` invocation, shared across physical write attempts and its browser error event. It is never an idempotency key or authority. The subsequent canonical GET remains a separate request. |
| `requestId` | Existing server-minted request ID. Join server stage/terminal events using it; the client cannot supply it through these parameters. |
| `patchConflictStage` | Server-only enum: `binding` at `roster_authorize` binding refusal; `precondition` at its version refusal; `cas` at `roster_ack` with captured preimage, no storage error, acknowledged write and matchedCount0. Otherwise `UNKNOWN`/absent. |

## Transport and trust

Only game PATCH URLs receive `__lk_diag_build` (exact40 lowercase hex) and
`__lk_diag_op` (canonical UUIDv4). The server projection runs only for exact
`PATCH /lk/games/:gameId` and `/lk/games/records/:gameId`. Each field is validated
independently; absent, duplicated, non-string, oversized or malformed claims
become `UNKNOWN`/absent. Unrelated query fields are never exported. These are
client-reported diagnostic claims, not verified identity or execution proof.

No custom request header, new CORS allowlist, payload field, authorization,
CAS predicate, expected version, business write or retry policy is introduced.
The legacy records alias retains its previous middleware response/header behavior;
its existing node hooks can still report the phase. Nothing forwards these
parameters to a Viva/provider URL. Browser telemetry still passes through the
existing strict sanitizer, minimal client-error envelope and bounded budgets.
No raw game/player IDs, phones, cookies, tokens, request/response bodies, error text
or expected/actual version values are added to diagnostic events.

A unique query makes each logical write URL different. Browsers may consequently
perform more OPTIONS requests instead of reusing a URL-specific preflight cache.
No extra business retry or new preflight header permission is required.

## Interpretation and failure behavior

Multiple HTTP attempts with one UUID differ from concurrent API invocations with
different UUIDs. UUIDs can be forged/reused; never infer exactly-once semantics or
suppress writes from them. `UNKNOWN` build/operation means insufficient evidence,
including old clients or unavailable randomness. Do not label every409 a retry.
The canonical read after409 is not a write attempt.

Phase comes from server hooks and Mongo acknowledgement facts, never a query or
browser claim. Only validated scalar claims/phase are retained in the existing
per-request WeakMap context, including the direct-route terminal409 event. Existing
suppression/retention rules apply. A missing/throwing observer, failed sink, invalid
metadata, missing crypto or frozen diagnostic context must preserve request results,
error responses and all business/CAS behavior. No raw payload or entity is retained
by the new projection.

## Activation and stop conditions

Future activation requires the actual frontend build plus separately reviewed
server observer/hook installation. `runtime.mjs` alone cannot produce missing live
`roster_authorize`/`roster_ack` hooks. Reuse the existing exact-source hook mechanism
with a fresh private live preimage, guarded contract, source/provenance checks,
lease, readback and recovery. Do not import a stale full flow or bypass a conflicting
scoped `lkDiagnostics` owner. This PR does not change settings, nginx, live flows,
collector registrations, keys or log destinations and generates no live artifacts.

Stop on any payload/status/CAS change, PII in output, mutation caused by diagnostics,
source drift, wrong artifact identity or altered response/CORS behavior. Keep the
Draft PR unmerged and disable/revert the observer change in its task branch until
corrected. Removing diagnostics must never undo or repeat a business operation.

Tests run actual request/write/read functions and existing function-node hooks
against fixtures, cover observer-disabled equivalence, terminal/sanitizer/collector
roundtrip, malformed claims, failed logging, clean/dirty build identity and strict-mode
frozen context. No real cancellations, refunds, payments or provider calls are used.

# EVENT pilot preparation (source only)

Owner: event organizer; audience: participants of «Корпоративный спорт ПадлхАБ». Outcome: required private registration, Падл Jump best-score ranking, separate Падел Микс link. Stop signals: policy missing/drift, authentication leak, score mismatch, repeated 409/429/503, replay CPU exhaustion or Mongo acknowledgement ambiguity. Stop method before release: do not activate EVENT; after an authorized release: disable Jump/configuration through the approved CUP path and keep data intact for reviewed recovery.

## Prepared source and compatibility

- Stable game IDs: `padel-jump` and `time-for-friends` (visible «Падел Микс»).
- Shared strict notice policy; draft settings without it remain closed. Direct, invited, existing and pending participants require a current policy-bound registration.
- Every EVENT roster writer (LK join/invite/member management + CUP moderation) increments `eventRosterRevision`; game/roster filters contain numeric fences rather than profile arrays. New EVENT activation must wait until all writers are upgraded; stale cross-type moderation conflicts. Mutation success requires acknowledged=true, matchedCount=1, modifiedCount=1.
- Private entries have epoch/revision/version and a server-computed one-calendar-year retention deadline. No provider write, mail, marketing opt-in, schema migration, new collection or rating-worker change.
- Candidate patching excludes disabled tabs, rejects duplicate active names/routes, reserves inactive IDs, validates generated auth routes/active wires, and upgrades only known V1 function bytes. Archived graph copies stay byte-identical. Production currently has disabled Media2 copies and one active LK Communities graph (structural read only); this does not establish a deployable full candidate.
- The synthetic fixture has no real owner/contact/policy and cannot open registration. The owner-provided dates/contact remain in the local launch draft, outside Git.

## Edge candidate: build only

Use a canonical mode-0700 private external workspace with a mode-0600 single-link source (symlink ancestors are rejected) and a freshly approved exact vhost preimage. No apply/reload command exists in the tool:

```sh
node scripts/nginx/prepare_event_community_guard.mjs \
  /private/fresh-vhost.conf /private/new-edge-candidate SOURCE_SHA \
  https://padlhub.ru https://padlhub.su
```

Outputs are a hashed vhost candidate, http-context maps/zones, and an event proxy snippet. Their install paths are `/etc/nginx/conf.d/lk-event-community-http.conf` and `/etc/nginx/snippets/lk-event-community-proxy.conf`; all three files form one candidate. Any live installation/reload is a separate authorized operation. Refuse an unfamiliar/nested/already limited parent configuration and refresh instead of weakening a guard. Full live config export was not performed; a synthetic rehearsal cannot certify a real vhost.

Only nested registration (`add-member`, `join-by-invite`) and event game routes receive limits: per IP 60 requests/minute + burst 20; global 10/second + burst 10; concurrent requests 6/IP and 30/global; 429 on overload; body 8 KiB for join/start/ranking and 192 KiB for replay finish. Other community reads/PATCH keep their prior budgets. Registration routes also cover ordinary communities, so confirm the small-pilot NAT/shared-IP budget before activation. Trust only the socket IP; do not add forwarded-IP trust without a separate review. Check the complete ingress route inventory so no alias or direct public Node-RED port bypasses this edge.

CORS uses an explicit exact-origin allowlist for protected routes, Vary: Origin, Authorization/Content-Type/X-API-Key/Idempotency-Key/X-Correlation-ID; preflight terminates locally. Correlation input is limited to 80 safe characters or replaced by nginx request ID; idempotency is forwarded unchanged. New proxy access logging is off; audit existing upstream/error/profiler logs for body/header/query redaction with synthetic requests. Global concurrency across multiple source IPs remains an activation test; the local rehearsal proves same-IP concurrency/release and the shared global rate budget.

Local rehearsal uses the existing cached immutable nginx image without a network:

```sh
node scripts/tests/prepareEventNginxFixture.mjs /private/tmp/event-nginx-synthetic
python3 scripts/tests/eventNginxRuntime.py CACHED_NGINX_IMAGE_ID /private/tmp/event-nginx-synthetic
```

It tests nginx syntax, allowed/denied origins, OPTIONS without upstream, idempotency/correlation, 413 before upstream, burst 429 with bounded mock calls, connection release, and unaffected unrelated community GET/PATCH. It never talks to Viva or a production endpoint.

## Erasure and retention rehearsal

Responsible operator must schedule deletion at the stored `retentionUntil` and handle earlier participant requests through the published contact. Use the exact verified account ID, not email/name/company. Verify the requester's identity through the established account channel before preparing a real plan. Scope is event forms/runs/best-score receipts, not the person's account, roster membership, sports rating or provider data.

The planner has no database client/network/apply mode. It can only prepare a private operator command and a non-identifying random operation receipt. Source/output must be outside Git in a real mode-0700 directory; source must be mode 0600 with one link, and output must be new. Never add raw documents or plans to Git/chat/email.

```sh
node scripts/prepare_event_erasure.mjs \
  --input /private/event-erasure/document.json --out /private/event-erasure/plan.json \
  --expected-sha DOCUMENT_SHA --now EXACT_UTC_ISO --actor VERIFIED_ACTOR_ID
# Alternatively: --expired instead of --actor (inclusive retention cutoff).
```

Actor deletion removes every epoch and run/result for that actor, leaves other entries and roster untouched, works after type rollback, and makes game access require new registration. Expiry removes only records with a known expired server deadline; a legacy/malformed deadline is a stop. Missing target is a no-op with no revision bump. Filter fences exact community/type, activation, policy revision and numeric entry revision; no full private array enters the filter. Mutation is one `$pull` plus revision increment, `upsert:false`. Any acknowledgement other than acknowledged + matched=1 + modified=1 stops; do not blindly retry. Read the exact record back and inspect counts in memory; log only operation ID, reason, revisions/counts and timestamp. Identifier-bearing command operands must remain out of profiler/driver logs.

Physical live erasure is intentionally irreversible and not authorized here. A real executor must use the existing guarded operator path with separate exact-target authority, this frozen plan, fresh identity/revisions and the strict acknowledgement check. The tool creates no PII backup. Existing backups have their own retention/access boundary: inventory them, establish expiry, record erasure tombstones outside participant payloads, and reapply erasure after any separately authorized restore before reopening. Restoring an old backup can resurrect deleted data; never treat source rollback as data rollback.

## Remaining activation gates (no operation authorized by this document)

1. Review/merge this follow-up LK + CUP source; retain original merged #221/#46 ancestry and compatible policy bytes. Include worker auto-enrollment helper exclusions; older workers must not run against an activated EVENT community. Build immutable release artifacts from the chosen clean commits with approved public production config; synthetic example.invalid bundles are LOCAL only.
2. Obtain an authorized private fresh active/disk preimage and exact graph/vhost manifest. The preparation's shape checks are not runtime graph acceptance. Refuse drift, inactive ID collisions, duplicate routes, foreign changes or missing expected functions. Preserve the existing Node-RED lease/backup/exact-graph rollback runbook.
3. Freeze the actual CUP unit/release path from fresh listener identity. The prior audit found `phab-api-p32-2be5b1f.service`, not the inactive generic `phab-api.service`; recheck at execution. Pin previous static LK/CUP artifacts and rollback commands. Never rebuild on the host or restore the database as automatic rollback.
4. In an authorized isolated runtime, prove Node-RED 4.x sandbox crypto loading, actual mongodb4 acknowledged result shapes, CAS conflict behaviour, direct/invite form round-trip, start/finish idempotency and server/browser score parity. VM doubles are LOCAL source evidence only.
5. With separate deployment authority: validate complete nginx topology and `nginx -t`, CORS in a real browser, socket-IP topology, protected ingress/aliases, limits under the expected NAT audience and global concurrency, redacted logs, backup/restore evidence, rollback and monitoring ownership. No server-writing preflight has been run here.
6. Create/configure the one chosen community only under separate exact-target authority, with its real owner/admin ID, approved notice/date/time and access rule. Do not import synthetic IDs/timestamps as live data. First run the complete scenario with synthetic accounts; invite real participants only after acceptance and retention duty/backup lifecycle are assigned.

Evidence levels stay separate: LOCAL source/build/container/browser tests and CI do not imply STAGING, PROVIDER or PRODUCTION. This preparation publishes only task branches/PRs; no live community, deploy, workflow dispatch, restart, database mutation, real questionnaire or external message.

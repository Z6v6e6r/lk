# EVENT pilot preparation (source only)

Owner: event organizer; audience: participants of «Корпоративный спорт ПадлхАБ». Outcome: required private registration, Падл Jump best-score ranking, separate Падел Микс link. Stop signals: policy missing/drift, authentication leak, score mismatch, repeated 409/429/503, replay CPU exhaustion or Mongo acknowledgement ambiguity. Stop method before release: do not activate EVENT; after an authorized release: disable Jump/configuration through the approved CUP path and keep data intact for reviewed recovery.

## Prepared source and compatibility

- Stable game IDs: `padel-jump` and `time-for-friends` (visible «Падел Микс»).
- Shared strict notice policy; draft settings without it remain closed. Direct, invited, existing and pending participants require a current policy-bound registration.
- Every EVENT roster writer (LK join/invite/member management + CUP moderation) increments `eventRosterRevision`; game/roster filters contain numeric fences rather than profile arrays. New EVENT activation must wait until all writers are upgraded; stale cross-type moderation conflicts. Mutation success requires acknowledged=true, matchedCount=1, modifiedCount=1.
- Private entries have epoch/revision/version and a server-computed one-calendar-year retention deadline. No provider write, mail, marketing opt-in, schema migration, new collection or rating-worker change.
- Candidate patching excludes disabled tabs, rejects duplicate active names/routes (normalized method/path uniqueness is checked both before and after graph assembly), reserves inactive IDs, validates generated auth routes/active wires, and upgrades only known historical function bytes. Archived graph copies stay byte-identical. Production currently has disabled Media2 copies and one active LK Communities graph (structural read only); this does not establish a deployable full candidate.
- The synthetic fixture has no real owner/contact/policy and cannot open registration. Historical private launch drafts do not supply authority for a new activation; use the confirmed scope below and obtain the missing current contact/owner.

## November exhibition: confirmed scope and open integration

Owner selected the current five-life Jump and shared live wall, not the older endless EVENT
game. The requested window is November 12, 2026 00:00 through November 14, 2026 00:00
Europe/Moscow: `[2026-11-11T21:00:00.000Z, 2026-11-13T21:00:00.000Z)`.
Responsible name/contact email were supplied privately on November 9; the owner confirmed
preserving the community's current OWNER. Do not commit those notice inputs or activate a
synthetic policy. Their receipt is not a production configuration change.

The existing team Jump is a separate single-community service with permanent result retention
and a companion first-name/last-name/email/company-website form. EVENT owns a mandatory
full-name/company/email registration in `lk_communities.eventEntries` with a one-year deadline.
Do not duplicate those records, map company into website, skip the EVENT form for an existing
member, or repoint the team service. A five-life exhibition requires an event-scoped instance
of the same game implementation, a PII-free canonical EVENT admission read, trusted player/board
destinations, activation/policy-bound results and a compatible retention/erasure procedure.
The owner confirmed a separate instance and supplied the community invite on November 9:
`community_1794221739126_корпспорт-падлхаб-2026` («КорпСпорт ПадлхАБ2026»). The last read-only
production lookup found FRIENDS/OPEN/INSTANT, one OWNER, zero forms and no EVENT notice.
That observation is not an activation; the later responsible/contact confirmation remains private.
The older endless EVENT game is not a fallback for the selected mode.

For this exact exhibition community, canonical direct and invite joins must reject with
`409/EVENT_NOT_STARTED` before the canonical policy's `startsAt`, including existing members
and already registered actors. No registration, roster or derived write is emitted in that
state. The start is inclusive and `endsAt` remains exclusive; no earlier phone acceptance is
authorized. Other EVENT communities retain their existing pre-registration behavior. The
scheduled exhibition UI alone is not a collection barrier. `EVENT_REGISTRATION_GUARD_V3`
enforces this narrow server rule; upgrade accepts only the pinned historical V1/V2 block,
and both current and historical guard drift fail closed. The frozen V2 fixture was captured
from actual `90533ec3` bytes, not fabricated from the new implementation. Review this
pilot-specific community binding after November 13; removing it does not erase stored data.

### Five-life integration source (not deployed)

- `patch_live_community_types.mjs --event-admission` adds authenticated, own-actor-only
  `GET /lk/communities/:communityId/event-admission`. It reads the canonical aggregate,
  returns membership/current-registration/policy binding, never questionnaire fields, and
  retains the existing verified-actor subflow and exact generated-graph guards.
- `createLiveServer({ event })` selects `/jump-exhibition-api/`, canonical EVENT registration
  and the same five-life replay engine. It does not create companion enrollment files and
  rejects the team's API alias. Without `event`, the existing team mode remains unchanged.
  `JUMP_EVENT_BINDING` is a strict JSON object with exactly `epoch`, `policyRevision`,
  `startsAt`, `endsAt`, `retentionUntil` and `inviteCode`, taken from the approved activation.
  Configuration itself never grants membership; start/finish require fresh own admission.
- Results carry activation/revision/retention binding. The exhibition never loads team,
  older-activation or other-policy receipts. New play stops at the exclusive closing instant.
  Only a terminal score already accepted by the server before closing may retry durable
  finish during the following ten minutes; that grace never accepts new movement. Result
  reads and spectator poses stop at the inclusive retention cutoff. Completed receipts
  survive service recreation; unfinished in-memory games do not survive process restart.
- `jumpExhibition=1` selects fixed exhibition player/board destinations, not an arbitrary
  client-chosen API. The actual EVENT full-name/company/email form is reused, including its
  responsible/contact/retention notice. The selected community's feed and ranking use this
  instance; neither its UI nor its backend falls back to the team or endless game.
- The cabinet build input `PADLHUB_EXHIBITION_GAME_SOURCE` must be the full reviewed immutable
  exhibition game source. Unset means closed, never the team's pinned module. Owner/purpose:
  event organizer, November pilot. Activation criterion: published exact game/backend source,
  verified notice/owner and complete phone acceptance. Review/remove the route binding after
  November 13; removal does not erase stored forms or scores. The team's existing module pin
  is unchanged. Cached game exports are keyed by module URL, not shared between targets.

The second service/store/port/edge installation, live erasure/backup acceptance for its result files,
exact-source release and live phone acceptance remain activation work. Do not repoint or restart
`padlhub-jump-live.service` (5193). The proposed exhibition target is separate loopback 5194,
`/jump-exhibition-api/` and a new private result directory. The event-specific health identifies
`event-retention-v1`; the team retains `permanent-v1`. Existing team packaging tools are not
implicitly approved for this new target. Hiding expired scores is not physical erasure:
canonical EVENT forms, separate game receipts/caches, private exports and backups must all be
covered by the designated operator's exact-target erasure/retention procedure before activation.

### Second-instance delivery source (not executed)

The existing first-activation packet/publisher now has a closed `--instance team|exhibition`
selector; default team unit/API/env template bytes remain unchanged. Exhibition selects
`padlhub-jump-exhibition.service`, its dedicated account, 5194, `/jump-exhibition-api/`,
`/opt/padlhub-jump-exhibition/releases/<source>`,
`/var/lib/padlhub-jump-exhibition/<community-hash>`,
`/etc/padlhub-jump-exhibition.env` and `padel-jump-exhibition-<source8>` static namespace.
Direct HTML under that owned exhibition namespace stays exhibition-scoped even without a query
flag. Existing team HTML and the cabinet's team module pin remain team-scoped.

- `scripts/package_padel_jump_live_147.py --instance exhibition` keeps clean/pushed exact source,
  successful exact-head CI, own fresh builds, private packet and source/hash custody gates.
  It accepts both repository task-branch prefixes (`codex/`, `agent/`). It requires approved
  public production build inputs and an external mode-0700 output parent; missing inputs fail
  rather than generating a guessed production artifact.
- Its projected community input must already contain the approved canonical EVENT policy,
  exact activation/revision and invite. The shared JS policy/binding parsers validate it over
  stdin without logging the notice. Do not supply a full participant dump or synthesize an
  activation timestamp to make packaging pass. Complete Node-RED/CUP writer upgrades before
  separately approved community activation, then take the exact bounded readback projection.
- `build:jump-live -- --instance exhibition` marks both archive/manifests with canonical-event-v1
  admission and event-retention-v1; publisher rejects team/permanent/old-rule contract drift.
  It validates the exact selected env, raw target names/prefix/port and pinned baseline unit/API
  template hashes **before** account/service/publication mutations. A mixed team field cannot
  disappear behind template normalization.
- Nginx preparation requires and preserves the existing team include. Publication/recovery
  operate only on the selected service/include/private paths. The original shared-vhost lock
  remains shared across both modes; recovery never restores an arbitrary stale full vhost.
- Exhibition inventory/protected checks fence existing team unit/env/backend and all existing
  game static releases, plus team PID/restarts/executable/hash/health. Only this exact new
  exhibition static namespace may be added; unrelated changes abort. This is source logic,
  not proof of a fresh production preimage, port availability or successful Linux installation.
- Do not use `update_padel_jump_live_147.py` or the team-only standalone frontend publisher for
  initial exhibition activation. They have not been generalized or executed for this target.
  The cabinet build's separate immutable exhibition pin and actual invite-page loader still
  need their own verified static publication in the approved ordered release.

LOCAL deployment tests include disposable-filesystem first activation/recovery and negative
instance/contract/env/mixed-unit/API cases, with systemd/nginx/account/runtime calls doubled.
They do not establish real host permissions, nginx syntax/reload or process restart acceptance.
Do not turn the test fixture's synthetic CI or runtime values into release receipts.

LOCAL evidence: canonical admission/access/HTTP and replay/finish tests use synthetic actors,
policies and disposable directories, not Mongo or real registration. The real form was rendered
at 390/1440 px: no horizontal overflow, 48 px actions, visible keyboard focus; one synthetic
submit handed off to the five-life start screen with exactly fullName/company/email/revision.
Scheduled/closed/pending/banned states expose no form. This is component evidence, not a real
QR/login/Mongo/phone end-to-end or production readiness claim. Independent integration security
review and exact-head CI are separate from the earlier bounded CSV-only review.

The EVENT replay builder now pins and embeds its complete simulation closure: campaign,
level layout and engine, using ordered filename-plus-NUL/source hashes. This repairs the
builder failure after shared engine changes; it does not convert endless EVENT into five-life
Jump or change the running team engine. Old incompatible EVENT results are not reinterpreted.

## Organizer questionnaire export (offline only)

`event:registrations:export` reads one already-authorized private snapshot and produces a new
mode-0600 UTF-8/BOM semicolon CSV containing only full name, company, email and registration
timestamp. Only the current activation/policy entries are exported, once per actor, before the
policy retention deadline, using fresh execution time (not a caller-supplied historical clock).
Missing policy, wrong target, malformed records or mismatched source
hash fail closed. Spreadsheet-formula prefixes are escaped. Console receipts contain only a
random operation ID, timestamp, revisions and count; no contact, participant or community ID.

```sh
npm run --silent event:registrations:export -- \
  --input /private/event-export/snapshot.json --out /private/event-export/forms.csv \
  --community-id EXACT_APPROVED_COMMUNITY_ID --expected-sha SNAPSHOT_SHA256
```

The snapshot and CSV must remain outside Git/public serving paths in canonical mode-0700
operator directories; input must be a mode-0600 single-link ordinary file, output must not
exist. No Mongo client, provider access, public endpoint, email or automatic upload is added.
Authorization to operate the tool and take a real snapshot remains separate from developing it.
Transfer the CSV only to the designated organizer over an approved private channel. It is a PII
copy subject to the same retention/erasure duty, including backup and downstream-copy handling;
no automatic deletion is claimed. An operator-held CSV is not a CUP questionnaire-management UI.

## Edge candidate: build only

Use a canonical mode-0700 private external workspace with a mode-0600 single-link source (symlink ancestors are rejected) and a freshly approved exact vhost preimage. No apply/reload command exists in the tool:

```sh
node scripts/nginx/prepare_event_community_guard.mjs \
  /private/fresh-vhost.conf /private/new-edge-candidate SOURCE_SHA \
  https://padlhub.ru https://padlhub.su
```

Outputs are a hashed vhost candidate, http-context maps/zones, and an event proxy snippet. Their install paths are `/etc/nginx/conf.d/lk-event-community-http.conf` and `/etc/nginx/snippets/lk-event-community-proxy.conf`; all three files form one candidate. Any live installation/reload is a separate authorized operation. Refuse an unfamiliar/nested/already limited parent configuration and refresh instead of weakening a guard. Full live config export was not performed; a synthetic rehearsal cannot certify a real vhost.

Only nested registration (`add-member`, `join-by-invite`), canonical `event-admission` and event game routes receive limits: per IP 60 requests/minute + burst 20; global 10/second + burst 10; concurrent requests 6/IP and 30/global; 429 on overload; body 8 KiB for join/admission/start/ranking and 192 KiB for replay finish. Other community reads/PATCH keep their prior budgets. Canonical admission is limited before its profile verification, not only by the separate game's caller budget; trailing slashes, endpoint case variants and encoded separators must not fall back to the unlimited parent location. Registration routes also cover ordinary communities, so confirm the small-pilot NAT/shared-IP budget before activation. Trust only the socket IP; do not add forwarded-IP trust without a separate review. Check the complete ingress route inventory so no alias or direct public Node-RED port bypasses this edge.

CORS uses an explicit exact-origin allowlist for protected routes, Vary: Origin, Authorization/Content-Type/X-API-Key/Idempotency-Key/X-Correlation-ID; preflight terminates locally. Correlation input is limited to 80 safe characters or replaced by nginx request ID; idempotency is forwarded unchanged. New proxy access logging is off; audit existing upstream/error/profiler logs for body/header/query redaction with synthetic requests. Global concurrency across multiple source IPs remains an activation test; the local rehearsal proves same-IP concurrency/release and the shared global rate budget.

Direct Node-RED access is not an exemption from provider budgets. The generated community-auth subflow places a process-global dispatch gate before its profile HTTP request, shared by every subflow instance and route. It permits at most 10 dispatches in any 1 second and 30 in any 15 seconds; the latter window exceeds the pinned 10-second provider request timeout. Budget denial restores the original request through the existing auth response: typed access fails closed as unavailable and FRIENDS retains its existing compatibility behavior. A separate admission ingress gate validates the GET, community ID, empty query, authorization shape and 8 KiB declared body bound before auth. Its graph and continuation are exact-shape guarded. Both budgets retain at most 30 numeric timestamps, never token/IP/actor keys; corrupt state, clock rollback or unavailable storage fails closed. These are local source/fixture properties until the reviewed graph is installed and read back; nginx alone is not protection when port 1880 is reachable directly.

The nginx admission cap also covers the normalized bare `/lk/communities/event-admission` path: an encoded slash-only ID can collapse to it. Decoded linefeeds must not evade the pattern either. These malformed aliases receive the same edge body/rate budgets, and the Node-RED admission gate independently rejects their invalid decoded IDs before profile verification. Keep both raw `%2F`-only and `%0A` regressions in the real nginx fixture; a regex-only check does not prove which upstream receives the original URI.

Bind the profile deadline through `msg.requestTimeout = 10000` before dispatch and restore the original field and own-property presence with the rest of the raw request. Installed Node-RED 4.0.9 reads this message field; a `requestTimeout` property on the HTTP node alone does not establish that deadline. Verify the installed HTTP request implementation before using the 15-second dispatch window as concurrency evidence.

With `senderr: true`, that HTTP implementation sends transport failures to Catch only, not its normal output. Keep the auth subflow's Catch scoped to the profile HTTP node, sanitize the captured failure to 503 before auth-response restoration, and remove its diagnostic error object; a stale caller status such as 401 must not turn an outage into invalid credentials. If any generated auth definition is present, every required definition must match or patching fails closed as drift. Follow-up finding: deleting all definitions while retaining an old instance is an inherited unsupported completeness edge case; it is not covered by that partial-definition guard. First-activation preparation must verify the fresh preimage has neither definitions nor instances, and the final candidate contains all expected definitions. The pinned official-consumer fixture tests effective timeout options and this error dispatch with owned RED/got stubs; it is not a full Node-RED runtime or measured provider/network timeout.

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

### Separate five-life score receipts and process caches

The canonical planner now accepts the exact Cyrillic community ID without transliteration.
It still does **not** delete the separate five-life filesystem archive. The bounded operator
tool `scripts/erase_event_jump_receipts.py` supplies that file-only scope; it is source, not an
installed job or approval to delete anything. It never touches the team archive, profile,
membership, provider, canonical Mongo collection, exports or backups.

1. Resolve the verified account ID and approve the exact erasure scope. For expiry, use each
   stored inclusive retention deadline; the confirmed notice ends retention at
   `2027-11-13T21:00:00.000Z`. Assign the responsible operator and backup/export lifecycle before
   activation. No retention cron/timer has been installed by this task.
2. Under a separately approved ordered operation, stop only `padlhub-jump-exhibition.service`
   and confirm it is inactive with MainPID=0. This retires the registry/spectator/admission
   caches and prevents score writes. Do not restart or stop the team service. Apply the exact
   canonical Mongo plan through the approved operator path, require strict acknowledged CAS
   and fresh readback, then prepare/verify the separate score plan against the actual stopped
   archive. A copy may be used for offline rehearsal, not as proof that live deletion occurred.
3. Offline example, with new external 0700 workspace / 0600 plan and a private receipt copy:

   ```sh
   python3 scripts/erase_event_jump_receipts.py plan \
     --directory /private/event-erasure/receipts --community-id EXACT_COMMUNITY_ID \
     --actor VERIFIED_ACTOR_ID --output /private/event-erasure/score-plan.json
   python3 scripts/erase_event_jump_receipts.py dry-run \
     --directory /private/event-erasure/receipts --plan /private/event-erasure/score-plan.json \
     --expected-sha PLAN_SHA256
   # --expired replaces --actor for expiry planning. CLI has no --now override.
   ```

4. Live file execution uses the separately approved immutable script/plan hashes and private
   operator path, **not** an arbitrary directory option. `apply` is dry-run unless `--apply`
   is explicitly supplied. The mutating CLI is restricted to root on the exact 147 host,
   the confirmed exhibition community, its hash-derived exhibition store/account and an
   already stopped exhibition unit. It holds the same lock as first activation/recovery;
   no stop/start command is issued by the eraser. A new private journal is persisted before
   unlink; interruption leaves an explicit reconciliation requirement, not an assumed success.
5. The plan seals the entire bounded inventory and selected file hashes. All epochs and valid
   `.pending-*` score receipts for the verified actor are included. Symlinks, unexplained hard links,
   wrong owner/mode, malformed/foreign rows, unknown filenames and timestamps stop before
   deletion. Expiry rechecks fresh execution time, including the exact cutoff; a future or
   stale preparation timestamp is not deletion authority. Files are read/unlinked relative
   to the owned directory descriptor, fsynced and read back; other actors' bytes are preserved.
   A writer crash after hard-link publication can leave a valid final/pending pair. With the
   exhibition still stopped, prepare a separate `plan --reconcile` (mutually exclusive with
   actor/expiry planning), seal its hash and dry-run it before the approved apply. Only a
   valid final plus pending name with matching inode/device/content/owner/mode and exactly
   two total links is admissible; outside links, two pending names and third links fail closed.
   This stage unlinks only the duplicate pending name, preserving all final receipt bytes.
   `LINKS_RECONCILED_REPLAN_REQUIRED` is not erasure success: prepare a **new** sealed participant
   or expiry inventory/plan afterward. The same live target, stopped-unit, journal and lock
   guards apply. No reconciliation runs implicitly during planning or registry startup.
6. Any partial unlink/fsync/readback failure produces `PARTIAL_RECONCILE`. Keep exhibition
   stopped, compare the frozen plan with physical state, and prepare a reviewed remaining
   operation; the stale plan cannot be blindly replayed after inventory drift. Never restore
   deleted contacts/scores as automatic recovery. After confirmed canonical/file erasure,
   cover private snapshots, CSVs, backups and downstream copies separately. File receipts
   explicitly retain those separate-readback duties and do not assert whole-person erasure.
7. Before any separately approved restart, verify fresh canonical absence (or a genuinely new
   registration), remaining file counts/hashes and the public board after a cold process start.
   Reapply erasure tombstones after a backup restore before exposing data again.

LOCAL tests execute actual private CLI planning/dry-run and disposable file unlinks, including
old epochs, complete pending files, actual writer-process exit after link publication followed
by a separate cold registry process, sealed duplicate-link reconciliation, actor isolation,
inventory drift, malformed UTC timestamps,
inclusive expiry and interrupted deletion. Live CLI wrong-target refusal is exercised without
systemd, live files, root role changes or shared-state mutation. Actual Linux custody/service
checks, physical production erasure and all downstream-copy signoffs remain separate evidence.

## Remaining activation gates (no operation authorized by this document)

1. Review/merge this follow-up LK + CUP source; retain original merged #221/#46 ancestry and compatible policy bytes. Include worker auto-enrollment helper exclusions; older workers must not run against an activated EVENT community. Build immutable release artifacts from the chosen clean commits with approved public production config; synthetic example.invalid bundles are LOCAL only.
2. Obtain an authorized private fresh active/disk preimage and exact graph/vhost manifest. The preparation's shape checks are not runtime graph acceptance. Refuse drift, inactive ID collisions, duplicate routes, foreign changes or missing expected functions. Preserve the existing Node-RED lease/backup/exact-graph rollback runbook.
3. Freeze the actual CUP unit/release path from fresh listener identity. The prior audit found `phab-api-p32-2be5b1f.service`, not the inactive generic `phab-api.service`; recheck at execution. Pin previous static LK/CUP artifacts and rollback commands. Never rebuild on the host or restore the database as automatic rollback.
4. In an authorized isolated runtime, prove Node-RED 4.x sandbox crypto loading, actual mongodb4 acknowledged result shapes, CAS conflict behaviour, direct/invite form round-trip, start/finish idempotency and server/browser score parity. VM doubles are LOCAL source evidence only.
5. With separate deployment authority: validate complete nginx topology and `nginx -t`, CORS in a real browser, socket-IP topology, protected ingress/aliases, limits under the expected NAT audience and global concurrency, redacted logs, backup/restore evidence, rollback and monitoring ownership. No server-writing preflight has been run here.
6. Create/configure the one chosen community only under separate exact-target authority, with its real owner/admin ID, approved notice/date/time and access rule. Do not import synthetic IDs/timestamps as live data. First run the complete scenario with synthetic accounts; invite real participants only after acceptance and retention duty/backup lifecycle are assigned.

Evidence levels stay separate: LOCAL source/build/container/browser tests and CI do not imply STAGING, PROVIDER or PRODUCTION. This preparation publishes only task branches/PRs; no live community, deploy, workflow dispatch, restart, database mutation, real questionnaire or external message.

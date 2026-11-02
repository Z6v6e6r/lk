# Private station notification feed v1

SOURCE only. Owner: LK station community/message owner. Audience: a future dedicated
LK2 notification importer, not browsers or ordinary user delegation. This packet
computes candidate facts/current eligibility; it installs no channel/rule, importer,
notification queue, key, environment setting, index, adoption or scheduler. It sends
nothing. Existing LK1 send/history/status and CUP roster APIs remain unchanged.

## Publication and audience authority

Only an explicitly adopted lifetime-v2/stream-v2 community is available. The exact
immutable committed message **and** stored event must match the existing owner
proof; its sequence must be covered by the contiguous `publishedSequence` frontier.
RESERVED records, READ_COMMAND receipts, old unsequenced archive and later published
slots behind a hole never appear. A missing/oversize/malformed/duplicate record or
missing event is unavailable, not an empty success or permission to skip a hole.
Reservation timestamps are not publication/delivery watermarks. No cleanup/backfill
or repair runs during a feed read.

The pinned candidate policy is current ACTIVE station members, actually present in
the roster, not banned, excluding the author, with message sequence greater than
both membership baseline and current readThrough. This is nonmandatory candidate
audience under existing preferences; it does not choose or enable notification
channels. A private canonicalUserId hint does not authorize mapping. The importer
must resolve unique valid canonical identity/binding separately, never by phone or
name and never by creating UUID mappings during reads.

Each original recipient binds player ID, membership epoch and baseline. ReadThrough
may increase below the message without losing eligibility. Covering the message,
LEFT, REMOVED, BANNED or a new epoch denies that original recipient. Restoration or
new registration captures current published frontier and cannot retarget queued
old-epoch work. Cancellation retaining membership is unchanged. An old acceptance
published *after* a new ACTIVE baseline may become newly visible; no recipient-at-
acceptance snapshot is invented.

Recipient pagination scans at most 50 player slots per page from the permanent
lifetime array sorted by ASCII private player ID. The continuation is last scanned,
not last eligible; an empty eligible page can still have a continuation. It is not
bound to moving global revision. After a fact is published, a newly ACTIVE epoch
gets baseline >= its sequence, so eligible membership for that fixed fact can only
shrink. Final current checks can remove a candidate but cannot add/recapture one.
This relies on the coherent existing writer floor, not a guessed roster snapshot.

Frozen paired writer evidence: CUP #72
`6a6301197cecbc90cb6ba37f55c520f3d39564c1`,
`src/communities/station-membership-lifetime.ts:49–63` pins stream/lifetime and assigns
ACTIVE baseline from frontier. `test/station-membership-lifetime.test.ts:63–82`
executes actual service moderation/old-validator refusal;
`test/station-membership-lifetime.mongodb.test.ts:83–100` exercises publication/read
race versus actual persistDocument CAS. These sources are dependencies; this packet
does not rerun CUP tests or claim their execution as its own. LK's actual
smRosterTransition/smTransition and existing stream owner tests cover local writers.
Old binaries must not downconvert v2 markers. No new CUP writer is introduced.

## Wire contract

Three new distinct read-only POST routes:

- `/lk/internal/station-notifications/v1/publications`
- `/lk/internal/station-notifications/v1/recipients`
- `/lk/internal/station-notifications/v1/eligibility`

All require `X-PadlHub-Station-Notification-Contract: station-notifications.v1`,
`X-Correlation-ID`, and `X-Station-Notification-Delegation`. No query parameters or
alternate route aliases. The request JSON has exact keys and <=8192 UTF-8 bytes.
Common fields are `{contractVersion:1,requestId,communityId,streamId,incarnationHash}`.
UUIDs are canonical lowercase. Community/player IDs are bounded existing private
owner IDs; they must never become public LK2 identifiers. Incarnation hash binds the
typed Mongo identity, namespace and community without exposing `_id`.

PUBLICATIONS adds `{afterSequence,throughSequence,limit}`. afterSequence is mandatory
and explicit: no zero/latest reset. throughSequence is null to capture current
frontier, or an exact prior fixed frontier; limit is 1..50. Counters are safe integers
in `[0,MAX_SAFE_INTEGER-1]`. Response adds `{throughSequence,items,nextAfterSequence,
complete}`. Each item is exactly `{messageId,sequence,authorPlayerId,proofHash}`;
sequence starts at 1. The message UUID is the existing public owner identity.
proofHash binds original request hash plus owner/identity/stream/sequence/author.
There is no body, text preview, author name/phone/avatar or reservation timestamp.

RECIPIENTS adds `{fact,afterPlayerId,limit}`, with fact exactly a publication item,
afterPlayerId null or exact prior last-scanned cursor, limit 1..50. Response adds
`{fact,items,nextAfterPlayerId,complete}`; item shape is
`{playerId,membershipEpoch,baselineSequence,readThroughSequence}`. It reports current
candidate recipients, not guaranteed transport targets or publication-time audience.

ELIGIBILITY adds `{fact,recipient}` with the exact original fact/recipient shapes.
Response adds `{fact,recipient,outcome:'ALLOW'|'DENY'}` and, only for ALLOW,
`currentReadThroughSequence`. Mutable readThrough must not go backwards; it may
advance below sequence. Current epoch and baseline must equal the original values.
Malformed/missing/deleted/recreated/archived/type-changed source is unavailable,
never evidence of a new stream or terminal no-dispatch proof.

Successful common response fields are `{contract:'station-notifications.v1',
requestId,ownerNamespace,communityId,incarnationHash,streamId,checkedAtMs,validUntilMs}`.
validUntilMs is at most checkedAtMs+5000 and within the original JWT/request deadline.
It identifies a **policy observation**, not an atomic provider permission or promise
that later delivery cannot race a leave. Consumers must use their bounded clock
budget, recheck before dispatch, fail closed on uncertainty, and retain original
custody. No CAS dispatch-permit mechanism belongs to this packet.

Errors contain only `{contract,requestId,error}` with literal codes:
STATION_NOTIFICATION_DISABLED (503), STATION_NOTIFICATION_AUTH_UNAVAILABLE (503),
STATION_NOTIFICATION_AUTH_INVALID (401), STATION_NOTIFICATION_REQUEST_INVALID (400),
STATION_NOTIFICATION_UNAVAILABLE (503). Unverified requests return null requestId;
no raw error strings, bodies, provider identities or credentials in diagnostics.
All responses use no-store. Only req/res transport handles remain on the final
Node-RED message; private DB/operation context is dropped before HTTP response.

## Dedicated service verification, disabled by default

Example configuration **names only**:
`LK_STATION_NOTIFICATION_FEED_ENABLED` (exact `true`), and same-prefix
`ISSUER`, `AUDIENCE`, `KEY_ID`, `PUBLIC_KEY_PEM`, `TENANT_ID`, `OWNER_NAMESPACE`.
No existing user/booked-operation/subscription/organizer credential is accepted.
RSA public keys must have >=2048-bit modulus. Header exact keys:
`{alg:'RS256',typ:'phub-station-notification-feed+jwt',kid}`.

Claims exact keys: `iss,aud,sub,jti,iat,nbf,exp,tenant_id,owner_namespace,scope,method,
path,body_sha256,correlation_id,request_id,contract`.
sub is `lk2-station-notification-importer`; scope is
`communities.station-notifications.<publications|recipients|eligibility>`; contract
is `station-notifications.v1`. Canonical tenant UUID and provider owner namespace
are separately pinned; current owner request-key namespace is `iSkq6G`, not assumed
identical to tenant UUID. exp>now, iat<=now, nbf=iat, exp-iat<=30 seconds; no positive
expiry grace. Signature/header/claims JSON use the existing recursively sorted
`smCanonical` serialization, encoded as canonical base64url (no duplicate keys,
noncanonical JSON or invalid UTF-8 accepted). body_sha256 is
`smHash('station-notification-body:v1',parsedBody)`: SHA256 of domain + NUL + canonical
JSON, prefixed `sha256:`. Correlation, body/request UUID, method and exact original
URL are verified. Both signer and verifier must use these bytes.

A valid service request may be replayed only for another fresh read within its short
expiry; it cannot create any candidate, receipt, event, membership or checkpoint.
There is intentionally no mutation nonce ledger. Disable this feature to reject
new reads; it neither rolls back messages nor loses importer custody. Config owner
is LK integration owner; review/remove rollout toggle only after paired importer,
worker-version floor and operational activation evidence. No actual key/config
installation is authorized by source work.

## Bounded reads and explicit cold-start readiness

Four Mongo aggregate operations: initial community, messages, exact events, final
community. Read preference primary, read concern majority, maxTimeMS 3000 per
operation, allowDiskUse false; total owner deadline min(start+10000,original exp).
A response cannot succeed after that deadline. No transaction, write or DB-client
creation; existing Mongo4 client is supplied to additive composer. Messages sort by
sequence with simple collation and named hint; at most limit+1 (51), or 2 for an
exact fact. Events at most 52, exact set equality. Entire message/event documents
must be <=65536 BSON bytes: oversize fails rather than successful truncation. Two
community matches (duplicate ID) fail; community rows retain Mongo's BSON document
limit. Full lifetime array is validated/scanned, not silently capped. An unusually
large lifetime may time out/unavailable; removal/ban paths are unchanged.

Approximate maximum logical BSON read volume per request: two community lookups
with <=2*16MiB each, plus <=51*64KiB messages and <=52*64KiB events. This is not a JS
heap/concurrency or latency guarantee. Parsing/validation cost, real membership
size, read concurrency limits, HTTP body admission limits, majority/primary topology
and cross-service clock bounds are activation evidence, not supplied by unit tests.

Required index proposal exported as `nfIndexProposal`: name
`station_notification_publications_v1`, ordered keys
`{communityId:1,streamId:1,sequence:1}`, nonunique, non-sparse, simple collation,
partial filter `{stationMessageOwner:1,recordType:'MESSAGE',state:'COMMITTED',archived:false}`,
no TTL. Query always supplies this hint; missing index returns unavailable without
fallback. Source does not create it. Event reads use builtin unique `_id`.
`stationNotificationReadiness(explicitCommunityRow,listIndexesResults)` validates
that exact named index and returns namespace/community/incarnation/stream/observed
frontier without roster data. Operator obtains these inputs with separately
authorized read-only lookup of one explicit community ID and listIndexes; no broad
discovery. The returned frontier is NOT a chosen import floor. Activation must pin
an explicit initial replay floor and those exact identities, validate actual
count/index/query timing and retained records, and never reset automatically.

## Composition, compatibility and remaining consumer gates

`patchStationNotificationFeed(bytes,{expectedFlowSha256,mongoClientId,tabId})` only
returns an additive candidate. It pins full input bytes, rejects reserved references,
route shadows/catch-all handlers and broad/ambiguous catch/complete observers;
explicit unrelated scopes remain intact. It changes no old node or public route.
Only fixed collection aggregate nodes exist in its own read graph; no dynamic
operation/write descriptor. New Mongo/router context has no debug/extra ingress.
Root owns generated graph/workflow/release handling; installation requires separate
reviewed preimage and runtime authorization.

Exact proof extraction is shared by the existing message owner and feed. Its
original UUID/requestKey/committedProof function bodies have an immutable baseline
byte characterization, plus actual existing compiled owner send/read compatibility
tests. Existing owner runtime release closure now needs stationMessageProof.mjs;
root separately fixes inherited Read/Stream/History packaging omissions and tests a
pure packaged module import. No claim those prior artifacts ran successfully.

Later gates remain: LK2 unique canonical mapping; durable per-source/per-recipient
import, holds/outbox/dedup/progress; channel rules/preferences; initial replay floor;
current-context dispatcher and mixed-worker isolation; generic inbox visibility and
honest unread semantics; canonical navigation; device/provider delivery evidence.
Do not emit on HTTP send success or status GET. Do not route station jobs to old
PENDING pollers lacking context checks. B's ordinary FCM/Web policy packet is an
independent dependency. This feed proves neither notification delivery nor a read.

## Required CUP writer floor

The feed requires the permanent station lifetime type fence in
[CUP #73](https://github.com/Z6v6e6r/ph-admin/pull/73), source
`20c2167a4f5188fee2745af5df41a6b76357b609`, in addition to the v2 stream owner.
CUP #72 alone allows STATION-to-FRIENDS moderation and a return to STATION with
an old membership epoch. Do not activate this feed with that writer. The paired
fix rejects adopted type changes and inconsistent rows, and fences stale writes
against adoption; install compatible writers coherently and drain old executions.
Existing inconsistent live rows need separately authorized owner recovery, never
automatic epoch repair. Source review and CI do not establish that installation.

## Evidence scope

Focused synthetic tests exercise actual message owner facts, auth, composed graph,
recipient shrinking, old epoch/author/bans, lower and covering reads, fixed-window
holes/corruption, >100-member pages and explicit readiness. Six guarded Mongo test
cases use only the existing CI Mongo8 service, two clients and task-owned random
DB/index fixtures; local execution skips, configured non-CI DB targets are refused.
They cover physical frontier recovery/pages, large audience, epoch/read races,
missing/corrupt proof, index/incarnation refusal and aggregate-only command capture.
No Mongo failover/durability claim follows from a standalone CI fixture. No local
DB provisioning, provider traffic, live reads, migration/index execution or keys.

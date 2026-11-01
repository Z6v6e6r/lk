# Station stream order and unread owner

Source contract only. This change does not adopt a community, deploy Node-RED,
create indexes, or prove production Mongo durability or device acceptance.
The paired CUP lifecycle writer and LK2 Web consumer must be installed coherently.

## Storage and publication

Unadopted communities retain their lifetime v1 and array outbox. Explicit adoption
uses `stationStreamAdoptionPlan` only as a plan: exact complete BSON preimage CAS,
old outbox absent/empty, new UUID stream ID, lifetime v2 and outbox v2 together.
There is no HTTP adoption command and no automatic first-open adoption.
Existing history stays accessible in ARCHIVE and is considered read; baseline zero
means the first new stream sequence, not an invented count of historical messages.

Outbox v2 contains `version,streamId,revision,acceptedSequence,publishedSequence,intents`.
A message acceptance atomically allocates `acceptedSequence+1` and its immutable
MESSAGE intent under current membership/epoch and exact outbox preimage. RESERVED
candidates have no sequence. Old candidates cannot upgrade after adoption.
The owner reads back the exact committed message AND event before marking its slot
published. Only a contiguous prefix advances `publishedSequence`; out-of-order
published intents stay retained. There is no time-based hole skip. Send/status do
not report a new stream message confirmed before that frontier covers its slot.
The old success DTO remains unchanged for ordinary legacy-shaped send.

Both MESSAGE and READ_COMMAND share the existing 32-intent bound. A blocked first
message can stop publication and eventually new commands; LEFT/BAN stays available.
Worker recovery is bounded and retains the exact original actor/epoch/body. A read
of an unproven receipt never repairs it. No Redis or secondary roster authority.
Counters (including epoch/revision) are safe integers in `[0,MAX_SAFE_INTEGER-1]`;
message sequences start at one. Overflow refuses mutation.

## Membership baseline and writer floor

Lifetime v2 adds the exact `streamId`. Every ACTIVE player must have
`readPosition:{streamId,baselineSequence,readThroughSequence}` satisfying
`baseline<=readThrough<=publishedSequence`. Missing/malformed state is unavailable,
never zero. New ACTIVE epochs capture the current contiguous frontier in the same
roster CAS, including CUP APPROVE/UNBAN and canonical membership confirmation.
Same-epoch moderation preserves the cursor. The roster CAS pins the full stream
preimage as well as the lifetime revision, so a concurrent publication/read update
forces a retry from a fresh state.

Actual pre-change LK/CUP validator fixtures reject lifetime v2. Old message writers
reject the object outbox; old worker array selection cannot claim these intents.
Neither rollback nor restore may downconvert either marker. Existing restore code
checks the full postimage inside its snapshot/majority transaction before replacing
any row; stream/read/lifetime changes invalidate that proof.

## Private history v3

Existing authenticated `GET /lk/communities/:communityId/messages` adds
`historyVersion=3`, `mode=STREAM|ARCHIVE` (default STREAM), `limit=1..50`.
Authentication remains the existing verified community actor; raw identity query
parameters are not accepted by v3. Private IDs/author identity stay integration-only.

STREAM initial request has no cursor: return the latest bounded ascending window,
`afterSequence=max(0,P-limit), throughSequence=P`, where P is the current contiguous
frontier. Any explicit `afterSequence` requires `streamId` and numeric
`membershipEpoch`; optional `throughSequence` starts or continues a fixed snapshot.
A consumer must carry that exact returned bound on continuation, and must not reuse
an old after value without its stream/epoch. Older pages use the same `(after,through]`
range; a fresh catch-up request may capture a newer bound.

Exact STREAM response fields:
`historyVersion:3,mode:'STREAM',streamId,membershipEpoch,baselineSequence,readThroughSequence,publishedThroughSequence,unreadCount,afterSequence,throughSequence,messages,nextAfterSequence,hasMore`.
Messages retain v2 fields plus integer `sequence`; order is contiguous ascending.
`throughSequence` is the fixed page bound F. `publishedThroughSequence` is the coherent
current frontier P, P>=F; current baseline/read may exceed an older page's F.
Unread counts all other authors in `(readThroughSequence,P]`, not P-readThrough.

ARCHIVE requires streamId/epoch and the existing optional `beforeTs,beforeId` keyset.
It returns the same state fields, `mode:'ARCHIVE'`, messages with `sequence:null`,
`nextBefore,hasMore`, and no STREAM range fields. Only unsequenced historical records
are included; old canonical records and legacy history retain v2 normalization.
READ_COMMAND is explicitly excluded by both query and renderer even if corrupted
visibility flags would otherwise make it look like a message.

All Mongo reads are bounded with maxTimeMS=3000. History uses one grouped count and
rechecks community identity, ACTIVE epoch, baseline/read cursor and frontier before
returning. Drift gives unavailable; it cannot silently claim unread zero.

## Read-through command and recovery

POST `/lk/communities/:communityId/message-read-requests`
with `X-PadlHub-Community-Read-Contract: station-read.v1`, exact body
`{requestId,streamId,membershipEpoch,throughSequence}`. UUID requestId is original
idempotency identity. No actor/phone or arbitrary fields. Through must not exceed P.

GET `/lk/communities/:communityId/message-read-requests/:requestId` uses the same
header/auth, no body/query, and only `find`; it never projects, changes cursor or
replays POST. Original request scope stays bound to the same actor and community.

Exact success:
`{contractVersion:1,contract:'station-read',requestId,outcome:'CONFIRMED',streamId,membershipEpoch,throughSequence,readThroughSequence}`.
Requested through and effective read cursor AT original acceptance are immutable.
Later reads never substitute a newer result. Same key/different body conflicts.

Unknown:
`{contractVersion:1,contract:'station-read',requestId:UUID|null,outcome:'UNKNOWN',code}`.
Codes: READ_REQUEST_INVALID, READ_REQUEST_CONFLICT, READ_ACCESS_DENIED,
READ_STREAM_UNAVAILABLE, READ_RECEIPT_UNPROVEN. Valid UNKNOWN may accompany
200/400/401/403/409/503; a malformed response is not a receipt. Old-epoch replay/status
is denied, not authority to mark a new membership read.

A hidden `recordType:'READ_COMMAND',archived:true,stationMessageOwner:1` candidate
uses a separate deterministic key namespace in the existing message collection.
It never receives sequence/message/event fields. Acceptance CAS atomically advances
only the same epoch cursor and appends immutable audit/receipt intent. Projection
persists that exact receipt then removes the intent by CAS. Recovery may project an
accepted receipt after LEFT without advancing any new epoch. Saturation fails closed.

## Private directory summary batch

Read-only POST `/lk/communities/station-stream-summaries`, header
`X-PadlHub-Community-Stream-Contract: station-stream.v1`, exact
`{communityIds:[1..50 distinct private IDs]}`; no supplied actor identity.
Existing generic community chat authorization is evaluated for every requested row
using the verified actor, never a phone/body fallback. Missing/foreign/unauthorized
row rejects the whole batch403. One find, grouped count and final find; no per-row
history requests and no mutation. Malformed/adopted unavailable state returns503.

Response `{contractVersion:1,contract:'station-stream-summaries',items:[...]}`:
- AVAILABLE: communityId, availability, streamId, membershipEpoch, baselineSequence,
  readThroughSequence, publishedThroughSequence, unreadCount.
- `{communityId,availability:'UNADOPTED'}` only for valid legacy station state.
- `{communityId,availability:'NOT_STATION'}` only for an authorized nonstation row
  with no retained station custody.

Only explicit UNADOPTED/NOT_STATION permits the separate legacy history UI. Transport
or adopted-state errors cannot be represented as either fallback or badge zero.

## Installation, rollback and evidence

Install compatible LK lifetime/message/history/recovery source, CUP moderation and
LK2 additive consumer before any separately authorized stream adoption. Compose the
history graph before the message-owner graph using their existing exact-preimage
patchers. Drain old writers/executors and old array outboxes first. Validate actual
production Mongo topology, connection identity, writeConcern/journaling, retention
and worker availability separately; source CAS tests are not failover durability.
Adoption remains an operator-reviewed plan, not an action in this source outcome.

Rollback keeps lifetime v2, stream envelope, candidates, events, receipts and read
positions. Old binaries fail closed; restoring old writers does not authorize
conversion or replay. Pending holes/capacity require compatible recovery, not deletion.
LOCAL tests are synthetic actual-helper/composed-node tests. Existing CI-only Mongo8
fixtures cover actual sequence CAS, delayed publication, READ/LEFT order, lost ACK,
count/pagination and original status; their execution is separate CI evidence.

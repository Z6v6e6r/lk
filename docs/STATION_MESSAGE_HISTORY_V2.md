# Opt-in STATION history v2 — source contract

Owner: LK communities. Consumer: LK2 authenticated community history. This packet changes only reads; it does not install a graph, create an index, alter stored messages, or implement unread/realtime/reconnect delivery.

## Wire and compatibility

The existing authenticated `GET /lk/communities/:communityId/messages` selects the new reader only with `historyVersion=2`. Absent version preserves the original prepare/query/response behavior, including old IDs and timestamp-only pagination. Unsupported/present malformed versions fail closed. The new reader requires a currently active verified STATION member; phone/clientId query inputs never authorize it. The original composed typed ACL runs before the new reads and again before disclosure; the latter read checks the same Mongo community identity, active roster/lifetime and bans. Community deletion/recreation, LEFT/BAN, archive or type change before that final read denies the page. A later mutation cannot retroactively revoke already authorized bytes.

Query:

- `historyVersion=2` (exact string), optional `limit=1..50` (default50).
- Optional `beforeTs`: positive integer epoch milliseconds, at most8640000000000000.
- Optional `beforeId`: lower-case UUID, requires `beforeTs`. The pair is exclusive.
- `beforeTs` without ID preserves strict older-than-time semantics for v1 cursor migration. It cannot recover ties already skipped by a previous v1 page; restart at the head.
- Existing private identity query names are tolerated for old integration compatibility but ignored as authority. Other query names, arrays, partial/malformed boundaries fail400.

Successful response has exactly:

```json
{"historyVersion":2,"messages":[{"publicId":"<UUID>","text":"<message>","createdAt":"<canonical ISO>","createdTs":1000,"authorName":"<name>","authorId":"<optional integration identity>","authorPhone":"<optional integration identity>"}],"nextBefore":{"createdTs":1000,"publicId":"<last retained UUID>"},"hasMore":true}
```

Rows are in strict descending `(createdTs, publicId)` order using binary comparison of lower-case UUIDs. `createdAt` is exactly `new Date(createdTs).toISOString()`; zero/missing/malformed time is never fabricated as history. Optional author identity fields are omitted when absent. They remain inside LK→adapter integration; LK2 strips them and exposes its public author DTO. No raw Mongo `_id`, old provider message ID, candidate/outbox/event data is returned. `nextBefore` is non-null exactly when `hasMore` is true, names the last returned row and implies a full requested page. A terminal page uses null/false. The consumer must verify the version; an older graph ignoring the opt-in query is not v2 evidence.

The boundary is a read position, not a signature or authorization proof. No secret/signer is introduced. LK2's opaque public cursor must bind its version, tenant and public community UUID before translating it to these private query fields. Reusing a position in another community cannot bypass its current ACL; the LK endpoint does not cryptographically attest position provenance. Deleted anchors remain usable, so the reader does not require an anchor document.

## Bounded Mongo reads and identity

The guarded composer adds only a focused read subgraph using the existing verified Mongo4 client and `find` positional options. Canonical query filters exact community, `stationMessageOwner:1,state:COMMITTED,archived:false`, with `(createdTs<T) OR (createdTs=T AND id<U)`, sorts `{createdTs:-1,id:-1}`, limits to `limit+1`, forces simple collation and `maxTimeMS:3000`. It retains existing canonical UUIDv8 IDs.

Historical query filters the same community and non-owner/non-archived rows, with a fixed2001-row limit and the same per-query execution time bound. More than2000 historical rows returns503, never a truncated successful page or false end. This caps only the compatibility subset, not canonical history. Selected legacy fields are projected, normalized and sorted in the owner, then merged with the canonical page. Legacy identity is UUIDv5 over a fixed namespace and domain-separated tuple `(tenant,collection,community,typed Mongo _id)`; supported persisted types are nonempty bounded string and ObjectId. A string and ObjectId with equal spelling remain distinct. Canonical v8 and historical v5 namespaces are disjoint; duplicate IDs/identities in the read set fail closed. `_id` uniqueness is provided by existing Mongo storage; public hash collision resistance is a cryptographic assumption, not a newly installed unique index.

Find projection expressions retain at most the allowed character count plus one for each used string, and reject unsupported nonstring fields before they can return nested objects. The extra character forces an oversize error; no truncated message is a successful result. At most9436 Unicode code points per projected row (including both time representations, bounded IDs and author fields), at most2001 historical plus51 canonical rows, gives a conservative string-content bound below78 MB of UTF-8 bytes, plus BSON/JS object overhead. Normalized rows and graph/runtime copies can coexist: this is not a process RSS limit. Initial/final community reads each return at most2 existing documents. Each Mongo operation has maxTimeMS3000; four sequential reads and the existing auth/network path do not have a new shared wall-clock deadline. The existing client/socket bounds and maximum concurrent reads must be measured before activation; this packet adds no global limiter and does not claim concurrency-safe capacity from a row limit alone.

Neither query exposes RESERVED/unpublished candidates. Canonical rows must match their timestamp/ID shape; legacy rows with unsupported identity or missing/invalid time fail closed. Read errors, unexpected cardinality/order/boundary and overflow use fixed redacted errors. No partial data/debug output is released.

Actual legacy row count/types, document sizes, canonical identity consistency, collection/index catalog and bounded timing are **activation prerequisites, not established runtime facts**. There is no demonstrated community-message compound index. Mongo may use a blocking sort; maxTimeMS bounds work by failure, not an IXSCAN guarantee. No index/backfill/TTL execution or provisioning is included. Existing projection/data cleanup must not delete/rewrite IDs. The historical subset must be frozen against old STATION writers by coherent owner installation and draining old graph requests.

## Scope and evidence

Canonical `createdTs` is original reservation time. Delayed accepted outbox publication can therefore appear behind an already consumed boundary. V2 is stable pagination of currently visible records, not a snapshot, delivery stream or reconnect high-water guarantee. A fresh head walk can find later publication; original request GET remains the independent way to restore one's own known custody. This packet changes neither mechanism.

Source: `scripts/lib/stationMessageHistory.mjs`, `stationMessageHistorySource.mjs`. The exact-preimage composer validates existing auth definitions, ingress/wires/client binding and reserved references; original legacy response and send/status nodes remain untouched. No wide graph regeneration is performed. Installation/release composition and CI workflow wiring belong to the integration owner.

Existing catch/complete observers are accepted only with explicit nonempty unique scopes naming existing unrelated nodes and understood structural/cosmetic fields. Missing/null/all scopes, unknown scope modes and scopes targeting the changed prepare/query or intermediate community read are rejected, as are references to new reserved nodes. This is deliberately conservative across tabs: an exact supplied flow hash alone does not establish observer isolation. The new scoped catch is the only added observer of private v2 read context.

Focused unit/actual composed function tests cover mixed equal-time multi-page walks, insertion order, duplicate body/distinct UUID, retry/deleted anchors, strict boundary/version/type/identity validation, ACL changes, old v1 characterization and finite overflow. `stationMessageHistoryMongo.test.mjs` uses only the existing guarded CI Mongo8 fixture and unique disposable databases; it refuses local/shared targets and otherwise skips locally. The pinned base workflow `.github/workflows/community-monthly.yml:93` specifies `mongo:8.0`, with Node22. Its physical evidence is pending CI execution. No local database, provider or live runtime was accessed.

The additive v3 stream/read-through contract is documented in [STATION_MESSAGE_STREAM.md](STATION_MESSAGE_STREAM.md). Legacy message renderers now explicitly exclude READ_COMMAND records.

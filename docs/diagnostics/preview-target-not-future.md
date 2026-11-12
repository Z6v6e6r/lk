# Preview start-time refusal diagnostics

Owner: LK backend maintainers. Audience: operators investigating a naturally
occurring group-training or tournament price-preview refusal. This is source
preparation only: no flow export/import, activation, restart or business replay.

`Subscription price preview router` emits one independent `node.log` info event
named `subscription_price_preview_target_not_future` only after the existing
`groupExercise` predicate `start <= Date.now()` has failed. The predicate, its
position, error code/details, HTTP 503 and lack of quotes remain unchanged.
The existing `TARGET_NOT_FUTURE` observer call and final refusal remain unchanged.
Count these as stages of one refusal, not additional failed requests.

The event deliberately bypasses the shared observer: a deployed observer can
filter for CROSS_DAY only and silently ignore this code. It adds no timers,
network/provider/database reads, global context, IDs or correlation headers.
An absent or throwing logger cannot change the refusal. It uses a closed local
shape (`schemaVersion: 1`), independent of the shared diagnostic envelope:

| Field | Allowed values / interpretation |
| --- | --- |
| `event`, `code`, `step`, `reason` | Fixed literals above, `TARGET_NOT_FUTURE`, `groupExercise`, `target_not_future` |
| `startRelation` | `PAST_AT_ENTRY`, `NOW_AT_ENTRY`, `CROSSED_DURING_REQUEST`, `UNKNOWN` |
| `startAlias` | First parseable `TIME_FROM`, `STARTS_AT`, `START_AT`, `FROM_TIME`, or `UNKNOWN` |
| `startFormat` | `ISO_OFFSET`, `ISO_OFFSETLESS`, `DATE_ONLY`, `OTHER`, `UNKNOWN` |
| `elapsedBucket` | Request age `LT1S`, `LT5S`, `LT15S`, `LE28S`, `OVER28S`, `UNKNOWN`; no exact duration |
| `explicitOffsetValid` | Boolean: full ISO with seconds, optional 1–3 fractional digits and explicit Z/offset roundtrips without calendar/time normalization |
| `aliasConflict` | Boolean: another parseable start alias denotes a different instant |
| `factsFailed` | Boolean: safe fact derivation failed; then all categories stay UNKNOWN and validity/conflict booleans are omitted |

No exercise/game/client/subscription/room/tenant/message IDs or hashes of them,
dates, timestamps, raw intervals, URL/query/body, provider text, auth or PII are
included. Platform log timestamps and existing diagnostic-envelope metadata are
not target dates. No new identifiers are introduced. The source parser and
validation path still own all business decisions; the diagnostic only examines
bounded primitive own data properties after the refusal, never custom coercion
or accessors. Unrecognized prototypes, unsafe values or disagreement with the
owning parser produce the fixed UNKNOWN shape without error text.

Interpretation:

- `PAST_AT_ENTRY` / `NOW_AT_ENTRY` means the returned, parsed start was already
  at/before request entry by server clocks. It does not prove the provider value
  was unchanged earlier or that the actual event had started.
- `CROSSED_DURING_REQUEST` means that same returned start lies after entry and
  at/before observation. A short read delay can explain the refusal; the bucket
  is total request age, not a measured provider latency.
- `ISO_OFFSETLESS`, `DATE_ONLY`, `OTHER`, false `explicitOffsetValid` or true
  `aliasConflict` identify time-contract hypotheses. Offsetless values depend on
  server TZ; permissive native parsing can normalize an invalid calendar date.
  These flags do not prove the provider intended a different timezone/instant.
- Invalid/missing/future entry clock metadata produces UNKNOWN relation/age.
  Server clock jumps, a wrong but syntactically valid provider time, and stale
  UI cannot be diagnosed conclusively from this event alone.

Only an already parseable, nonfuture target reaches this event. Missing/invalid
start, upstream/identity/category failures, future targets and overall timeout
keep their previous paths and do not emit this event. Later room/duration/status
guards have not been validated by this refusal. No UI, booking or payment change
is part of this diagnostic.

Verification: fixed-clock tests in `subscriptionPricePreviewBackend.test.mjs`
exercise boundary ±1ms, entry/crossing, age buckets, explicit offsets, midnight,
offsetless/date-only/calendar normalization, conflicting/fallback aliases,
unsafe values/accessors, absent/filtered/failing observers and failing logger.
They verify the exact error response and no downstream reads on refusal. Run
the suite in UTC, Europe/Moscow and America/Los_Angeles; fixtures are synthetic.

Natural acceptance after separately authorized deployment: observe a bounded
event and its ordinary refusal with matching safe context, then classify only
what its predicates establish. Confirm natural future-preview success on the
same release. Quiet traffic is insufficient evidence, and business calls must
not be replayed just to populate logs. Exact request identity remains UNKNOWN
where the existing evidence cannot safely bind it; do not merge independent
requests by second alone.

Touched source node: `lk_subscription_price_preview_20260908_router`, endpoint
`POST /lk/subscriptions/game-price-preview`. No graph, entry/final, shared
sanitizer/schema, pricing rules or tracked flow artifacts change. A future
activation requires a fresh verified live preimage and a focused reviewed
candidate. Stop on unexpected fields or effect on responses; restore the
reviewed router preimage under separate operational authorization. Turning off
the shared observer does not stop this independent info event.

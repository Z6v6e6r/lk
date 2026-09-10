# Annual operator environment and fresh reconciliation — 2026-09-10

Preparation is blocked before production maintenance. The isolated dependency
package is built, and the fresh read-only Viva/Mongo reconciliation completed.
Two concrete BSON compatibility defects prevent treating the operator as ready.
No sales flag, production ledger, Viva product/payment, PM2 definition or runtime
was changed by this stage. Existing task branch and main work were preserved.

## Fresh server evidence

At 08:10:12Z (11:10:12 Moscow), all 150 discovered transactions were individually
read from Viva after complete, strictly checked transaction pages. Each operation
passed financial, client, subscription-instance and refund fact validation.
This run made 310 provider GET requests and one authentication request. Raw
records and credentials remained in server memory; only aggregate diagnostics
were exported. No raw snapshot was persisted or retained as an execution packet.

| Fact | HAB annual | Piter annual |
| --- | ---: | ---: |
| Canonical transactions read | 58 | 92 |
| Positive-price paid subscriptions | 18 | 42 |
| Free paid-status issues, excluded from paid quota | 18 | 5 |
| UNPAID watches, preserved | 19 | 42 |
| Provider refunded transactions | 3 | 3 |
| Positive-price paid outside local rows | 14 | 2 |
| Local rows | 20 | 83 |
| Local PAID rows with proven provider refund | 1 | 2 |
| Capture span including runtime readback | 12.253 sec | 9.276 sec |

HAB catalog cost is 9,800,000 minor units (98,000 RUB). Piter catalog cost remains
5,680,000 minor units; the intended checkout price is still the existing
19,800 RUB after discount. Both catalog products have activationDays=1,
validityDays=365 and visits=365. No catalog edits were performed.

The diagnostic plan is rejected with ANNUAL_OPENING_LOCAL_SCOPE_INVALID for both
products. All other local-scope predicates passed; idInvalid affected all 103
rows. A separate minimal projection read at 08:11:25Z confirmed all 20 HAB and
83 Piter identifiers are BSON ObjectId. Both canonical annual sentinels are absent.

The 42 positive-price Piter payments support the approved calculation
100 - 42 - 10 = 48 remaining in its opening batch. HAB has 18 counted prior
payments. These are read-only reconciliation facts, not an approved execution
packet or activated quotas. Three local refund-status corrections remain pending;
this means recording already-proven Viva refunds, not issuing new refunds.

Live flow still matched 12ed9b7a70d086f0640a7d0332213b7baf5b02dd5756eebe0317ec0fc611f31b.
Authenticated common/HAB/Piter globals were OFF and attestation valid. The existing
admin session was used solely for the already-authorized flag/attestation GETs;
the token never left the server. Permanent annual operator release.json remains
absent. Default production driver is 3.7.4, Node v22.23.2, architecture x64.

## Prepared dependency artifact

Private root: /private/tmp/lk-annual-operator-preparation-20260910 (0700).
The package contains the existing reviewed 17-file operator source closure plus
its own package/lock, 12 locked dependency packages and a preparation probe.
The dependency lock is derived from the existing partner-game-membership-api
lock; only root package identity was adapted. No partner runtime is included.

Linux npm ci --ignore-scripts --no-fund --no-audit passed. Exact ESM import from
the operator scripts directory resolves to its private node_modules/mongodb.
MongoDB Node driver 7.2.0 and BSON 7.3.2 were verified with Node v22.23.2 on Linux
arm64. Linux root ownership, no symlinks or group/world-writable files, all
installed package versions, npm integrity entries and 576 file hashes were
recorded. BSON Int32/Long/Date canonical round-trip passed. Production x64
installation/execution is not claimed; the isolated package was not uploaded.

- Dependency tree SHA256: 95fcb836f65b938c4e8abc12160434d1c5013954face458af3cf13f752f45450.
- Archive: annual-operator-prepared.tar.gz, 1,413,070 bytes.
- Archive SHA256: e468291979b39dffcf060ae77be3bb6cfcc5f08d57d015acd765804eba076007.
- dependency-manifest.json and archive-receipt.json preserve detailed evidence.

The dependency manifest is preparation evidence. The production operator's
existing publication descriptor does not cover external dependencies. A protected
installation and dependency verification under execution custody are still needed
before any use; the package alone does not close that gate.

## Confirmed blockers

1. Real ObjectId is incompatible with the opening/maintenance identity contract.
   annualSubscriptionOpening.mjs requires string _id and uses string sorting;
   maintenance converts BSON to relaxed EJSON, where ObjectId becomes a $oid
   object. Older JSON-exported diagnostics implicitly converted ObjectId to hex
   strings and therefore did not establish compatibility with live BSON.
   Identity support must preserve native BSON type through evidence, lookup,
   exact filters, intent and recovery; production IDs must not be rewritten.

2. Lossy relaxed-EJSON normalization and expected BSON postimages diverge.
   manage_annual_subscription_history.mjs:143 converts Long to JS Number;
   :149 adds the new sentinel without restoring its actual BSON representation.
   The expected canonical EJSON can encode that number as Long while the driver
   stores Double. Long values outside the safe integer range also lose precision.
   The recovery rebuild at :127 has the same normalization boundary.
   A physical snapshot/majority transaction on a disposable Mongo 7 replica
   acknowledged the HAB seed insert, then detected the exact postimage mismatch
   and aborted. Majority readback confirmed original rows unchanged and no sentinel.
   A specialist also reproduced the representation mismatch for 2147483648,
   without relying on an already-imprecise maximum Long. Weakening the digest or
   removing BSON probes from the test would hide the defect, not fix it.

## Executed checks and limits

PASS: collector syntax; 12 pagination positive/negative assertions; independent
payment-evidence review; local audit-module import check; Linux pinned dependency
install/resolution/version/custody/BSON round-trip; read-only production history,
ObjectId type projection and OFF readback; synthetic BSON database round-trip,
opening and seed-plan construction; abort and exact original-fixture readback.

FAILED: physical annual seed postimage equality. Consequently successful commit,
Piter mutation rehearsal, lost-ACK recovery, duplicate-apply refusal, refund
transaction and full maintenance CLI/grant/PM2 custody are NOT PROVEN in this run.
No application source changed, so full app build/lint and unchanged prior CI were
not rerun. The rehearsal used actual Mongo on a network-disabled local container,
not a shared endpoint. The exact failed synthetic fixture was saved as canonical
EJSON with hash 4b48ae96c893133b60c3ff5c6397a18b689d1fa901a8af6467e0133c494719b6,
then only the task-owned container was stopped.

The initial raw-data export was rejected by automatic approval review. It was
replaced with a permitted safer server-memory audit, producing aggregates only.
Transient SSH failures and a locally fixed audit-module packaging error delayed
collection; neither was interpreted as successful evidence. Raw customer data
was never exported in this stage.

Private reproducibility material: collect-redacted.cjs, prepare-redacted-audit.mjs,
audit-redacted.json, id-types-redacted.json, dependency-manifest.json,
rehearsal-src/ and rehearsal-reports/. These contain either source, aggregate
results or synthetic fixtures; no live raw record exports. The initial unexecuted
raw collector is retained privately for chronology, not as an approved run path.

Next work is a bounded source correction for lossless BSON identity/postimages,
followed by the complete isolated transaction/recovery rehearsal and review.
Permanent publication, renewed fresh evidence, writer quiescence, historical
maintenance and activation remain separate later steps. This stage must not be
reported as opening-ready. No merge, push, PR, deployment or production mutation
occurred. Only this report and WORKLOG are changed in the existing task branch.

# Annual subscriptions Golden HAR preparation — 2026-08-22

Status: **SANITIZED / NOT REVIEWED / NO-GO FOR CANONICAL PROJECTION**.

This checkpoint re-sanitized the three supplied Viva captures into private temporary artifacts. Raw
HAR files, sanitized HAR files and manifests are intentionally excluded from Git. No provider call,
booking, payment, Viva mutation, MongoDB write, policy publication or feature activation was made.

## Sanitized artifacts

| Case | Retained / removed | Sanitized SHA-256 | Proven read paths |
| --- | ---: | --- | --- |
| `GHAR-MAP-PITER-PRODUCT-DICTIONARIES` | 10 / 14 | `be052c92d1ffe35e9b3b3b948947272768eccb81cee21a3822882971714f59ff` | `GET /api/v1/products/subscriptions`, `/api/v1/studios`, `/api/v1/exercises/types`, `/api/v1/exercises/directions` |
| `GHAR-MAP-PITER-CLIENT-SUBSCRIPTION` | 6 / 11 | `d30d89bb0d330d7fc861f1b9abc0a9adfa53b4b8acfdc49075b0a8a7f0ab65d1` | `GET /api/v1/clients/{alias}/subscriptions`, `/api/v1/clients/{alias}/card/statistics-snapshot` |
| `GHAR-MAP-HUB-PRODUCT-DICTIONARIES` | 6 / 94 | `bf67c9d0950870df6d4cdc91bfdcede0a8e87d499dee5f216e5b2d0d5e9239c8` | `GET /api/v1/products/subscriptions`, `/api/v1/studios`, `/api/v1/exercises/types` |

All three structural scans found only `api.vivacrm.ru`, zero sensitive-value leaks, zero
authorization leaks and zero unexpected non-JSON bodies. The HUB source contained 94 unrelated
browser entries; the sanitizer removed them rather than trusting the source filename.

## Sanitizer correction

One source contained a legitimate high-precision browser timing whose decimal digits matched the
phone-token detector. Browser timing fields are now rounded to millisecond precision (three decimal
places) before the final privacy scan. A regression test proves that the phone-like digit sequence
does not survive while the timing remains useful for diagnostics.

This changes only the evidence sanitizer. It does not alter LK runtime or business rules.

## What the captures do not prove

The retained reads are useful inventory and dictionary evidence, but they do not contain the full
canonical target contract required for an annual subscription decision:

- action-specific target exercise/product identity for create, join, training or tournament;
- one exact target's station, duration and `startsAt` tuple;
- authoritative statement that price is integer RUB minor units;
- separate target and price evidence references;
- unavailable, expired/stale and repeated-read stability cases;
- an independent reviewer approval digest.

Therefore every case remains `SANITIZED`. None may be labeled `REVIEWED` or `APPROVED`, used to
insert `subscription_canonical_target_snapshots`, publish Piter/HUB v2 or enable LK1/LK2
enforcement.

## Required next evidence

Capture and sanitize a bounded read-only series for each supported action: exact target list/detail,
dictionary mapping, exact price source and unit, a repeated identical read, an unavailable target and
a deliberately stale observation. A reviewer must then reconcile every derived field, assign the
separate evidence digests and record approval under the Golden HAR contract. Only that approved
input can enter the canonical producer gate.

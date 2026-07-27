# Classic Mexicano recovery — 2026-07-26

## Provenance

The recovered algorithm and focused tests are the exact postimages preserved
by the 2026-07-25 quarantine patch:

| File | Git blob |
|---|---|
| `src/components/tournaments/mexicanoClassic.ts` | `770adc7330fae0188324ea45c577d66eac4e19c1` |
| `scripts/tests/mexicanoClassic.test.ts` | `1832a0f69dae8c55ddc253461a78dc5575b86314` |

The current quarantine files were accepted only after their blob hashes
matched the recovery patch. The concurrently changing quarantine
`TournamentsPage.tsx` was not copied.

## Recovered contract

- Classic Mexicano creation uses its own deterministic generator and params.
- Frontend remains the owner of next-round generation.
- Saving the final match of round N sends the score plus every layout-only
  match of generated round N+1 in one `/lk/tournaments/americano/results`
  request.
- Layout-only results are represented with optional scores and include court,
  court index, and both pairs.
- The UI does not accept a successful response until every generated round is
  returned with a complete layout.
- The local manager rebuilds the next Classic Mexicano round from the
  acknowledged server rounds.
- Tournament history restoration now accepts `tournamentType="mexicano"`.

## Scope boundary

No Node-RED flow or server was changed. The existing endpoint already accepts
layout-only matches; this commit changes only the frontend contract and its
TypeScript representation.

The newer production offline-result queue is not present in clean
`origin/main`, so its queue/retry infrastructure is not copied as part of this
focused recovery. Online atomic persistence is recovered; offline retry parity
remains a separate dependency-recovery task.

## Checks

- Classic Mexicano focused suite: 20/20.
- TypeScript application check: pass.
- Targeted ESLint: no errors; three pre-existing hook warnings in
  `TournamentsPage.tsx`.

# Tournament owner integration — source candidate, not deployment

CUP owns canonical admission and durable capacity holds for LK1. LK2 consumes separate CUP
operations and is outside the LK1 release. Direct provider ingress is an accepted product risk.

## Browser

`apiCreateTournamentVivaTransaction` routes server-classified tournament selections to
`POST PHAB_API_BASE/tournaments/:exerciseId/checkout` with an actor/target stable key. It forwards
selected product source/ID, promo and return URLs. CUP rebuilds the existing Viva v2 cart and derives
actor/studio from trusted data. The browser cannot submit amount, discount or invitation overrides.
One-time, owned one-time and subscription-plus-tournament retain their cart form. Existing
custom-energy and owned-subscription/money-discount paths retain their price logic and dedicated
owners. They do not fall back into the ordinary transaction route.

Unknown means recovery of the original operation, even under a different key. Browser result
resolution uses only the acknowledged transaction, never a client-wide websocket or single unrelated
exercise booking. Paid completion asks CUP to reconcile by exact transaction attribution.

## Node-RED source integration

Use `scripts/prepare_tournament_admission_candidate.mjs SOURCE SHA256 NEW_OUTPUT` on an approved,
fresh, complete exported booking graph. All three paths must be absolute; output must not exist.
The source hash, unique node IDs, router ID/type/outputs and function syntax are validated. Only
the router's function and library list change. The installer appends the built-in Node `url`
library for the Function VM and preserves the current Viva v1/v2 routing expression, existing
libraries, lifecycle hooks, node order, wires and other node fields. Apply last,
after LK1 daily-visit, discount and managed-entitlement overlays. Do not rebuild from a stale base.
The installer is local-only: it cannot deploy, import, restart or edit a live runtime.

At an authorized release use the repository live-workspace validation workflow and
`node-red-release-validation` skill first. Validate disk, runtime, editor, worker and topology;
this task intentionally did not import active flows or assert that the deployed path has changed.

Required server configuration (configure only during separately authorized rollout):

- `TOURNAMENT_OWNER_API_BASE`: trusted HTTPS CUP base including `/api`, no query/credentials/hash.
- `TOURNAMENT_OWNER_INTEGRATION_TOKEN`: existing CUP LK integration credential; server-only.

Gate before preaccept, managed entitlement reserve and provider create:
`POST /tournaments/:exercise/subscription-admission`, Bearer, original operation/subscription IDs.
The returned grant binds actor, exercise, subscription and request ID. A GET preview never grants
write authority. A confirmed booking calls `/subscription-admission/complete` with the service
credential, and CUP atomically transfers its hold to a participant. This is retryable; missing
completion evidence remains pending. Browser credentials alone cannot finalize that receipt.
For LK1 operations covered by the v1 daily guard, acquire or read back the operation's guard
before requesting the CUP hold. A request blocked by another event's guard leaves no CUP hold.
A definitive initial CUP refusal can release only the guard owned by that original request.

Definitive refusal CASes only the exact PREPARED operation without dispatch, booking, visit or
entitlement markers, then reads it back. Only its matching daily guard is marked released; takeover
uses exact owner CAS. Crash after refusal, lost ACK and stale cleanup are recovered from durable
state. Timeout, unknown result, foreign guard and used entitlement are never treated as refusal.

## Local reproducible checks

```sh
node --test scripts/tests/tournamentAdmission.nodered.test.mjs scripts/tests/groupScheduleCheckout.test.mjs
node --test scripts/tests/lk1DailyVisit.test.mjs scripts/tests/subscriptionBookingReserveIngress.test.mjs
TEST_MONGODB_URI='mongodb://127.0.0.1:27138/?replicaSet=tournamentTask&retryWrites=true&w=majority' node scripts/tests/tournamentAdmission.mongo.test.mjs
npm run lint
npm run build
```

The Mongo test requires an explicitly supplied loopback replica set, creates a random synthetic
namespace and drops only that namespace. It executes the patched router against actual Mongo CAS,
including real daily-guard composition after ctx initialization. No provider network call occurs.
The full prod+dev build requires the established ignored `.env`/`.env.dev` configuration. Generated
bundles/manifests and local environment files are not committed. `nodered:modular:validate` requires
a separately prepared external live workspace; no such live workspace is claimed by this candidate.

## Provider acceptance

Use an authorized Viva test tenant to verify single payment, composite cart, an existing promo,
successful cancellation and repeat registration, and recovery of the original operation after
timeout or restart. Require custody of the exact transaction, participant and seat hold at each step.

## Definitive refusal after admission (2026-11-18)

The exact `exercise_recheck` refusal `SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE`
now records a majority-acknowledged `FAILED` operation with `tournamentAbort.proof =
PRE_DISPATCH_REJECTED_V1`. Preaccept persists the complete CUP grant and the new
`tournamentProviderPhase: PRE_DISPATCH`. The historical `upstreamAttemptedAt` remains
compatible and is **not** evidence that a provider POST happened. Immediately before the
actual booking POST, an exact CAS changes this phase to `DISPATCHING`; a lost CAS ACK
permits neither a POST nor an abort. Abort and dispatch cannot both win.

The durable refusal resumes through the existing operation lookup after restart/retry,
sends authenticated `POST /tournaments/:exercise/subscription-admission/abort`, and binds
ownerOperationId, original request operation, subscription, actor, exercise and tenant.
CUP releases only that original hold. A lost HTTP or Mongo ACK repeats the same abort.
The response is verified before recording `acknowledged`; the original daily guard is
then released by exact owner CAS. `cleanupComplete` is recorded only after guard readback.
A new request cannot reclaim the old operation between ACK and guard cleanup. Recovery
uses the persisted service date even if the exercise has moved. This is request-driven
recovery, not a new background scheduler. Legacy rows without this proof are not aborted.

Shared-day/category-day ledger keys may be reused by another event or category. An unfinished
abort blocks that new request before generic reclaim, and the reclaim CAS independently requires
either no abort marker or acknowledged compensation plus completed guard cleanup. Recovery of the
original request remains available; a new event never substitutes its fields into the old CUP grant.
Physical Mongo tests cover crashes before the CUP ACK and before cleanup, a stale reclaim snapshot,
and successful cross-event reclaim only after both acknowledgements.

Managed LK1 tournament requests using a v1 daily visit can also compensate after the
exercise or tariff recheck yields a fresh valid quote for the exact exercise with a
changed fingerprint. The request must own the guard. The refusal CAS requires the
original stored quote, grant, service date and `PRE_DISPATCH` phase without booking,
dispatch, entitlement, money or visit effects. Unavailable, redirected, malformed and
unknown results retain the existing reconciliation path. The CUP abort wire contract
remains `PRE_DISPATCH_REJECTED_V1` and `SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE`.
The original LK1 ingress ID recovers the same result even after a process restart.
An independent seat release cannot take over compensation once the abort marker exists.
A `COMPLETED` abort response never triggers LK1
cleanup. CUP atomically retains the participant when completion won; an aborted operation
cannot later acknowledge completion.

Compatibility: add the CUP abort endpoint before enabling this LK1 candidate. Do not
roll back to a router that can reclaim FAILED rows while new abort/cleanup records remain
unfinished. No flow import or active-runtime validation was performed. Local Mongo tests
use only random disposable namespaces and synthetic provider responses.

## Совместное восстановление канонического уровня и турнирного владельца

`TOURNAMENT_OWNER_RECOVERY_ONLY=true` в CUP и в новом runtime Node-RED закрывает новую
операцию перед созданием CUP hold или захватом дневного guard. Ранее подтверждённая
платёжная квитанция, операция с сохранённым грантом, завершение и исходный abort
остаются доступны. Для CUP/RBAC включение режима требует отдельного согласованного
выпуска. Отдельный выключенный серверный booking path следует оставить выключенным.

Для возврата фронта используйте сборку, которая уже читает уровень у ЦУП и отправляет
турнирную оплату в CUP. Старый router без abort/reclaim fence и фронт, читающий Viva,
для восстановления непригодны. Канонический backend, sender и новые workers остаются
совместимыми. Исторические CUP recovery payloads для MAX и медиа имеют отдельную область
применения и не заменяют текущий канонический backend.

Признак отмены для записи CUP берётся из точной строки истории Viva и сверяется с
активными записями. Для checkout привязка включает транзакцию, для абонемента уже
сохранённый bookingId. Отсутствие или противоречие хранит исходный резерв.
`OWNER_CANCELLED` сохраняет журнал и освобождает только его место. Новый ключ
проверяет свежие правила и уровень. Поздние ответы исходной записи не меняют
следующую операцию. Бесплатная запись использует один удержанный слот и один вызов
Viva booking после проверки уровня, gender, точной привязки и полного пустого каталога.
Платёжная команда и списание абонемента в этой ветке отсутствуют.

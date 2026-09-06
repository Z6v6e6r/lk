# AGENTS.md

## Project

PadlHub LK is a React 19 + TypeScript + Vite widget for Tilda.
The project includes:

- IIFE frontend bundles for the cabinet and overlay modules.
- Node-RED backend flows for games, chats, communities, support, MAX bot, and payments.
- VivaCRM, Keycloak, SERV2, Firebase/FCM integrations.
- Community rating, recalculation, and data repair scripts.
- Android/Capacitor wrapper artifacts.

## Read by trigger

For every task:

- read the applicable `AGENTS.md` instruction chain;
- inspect the relevant package, module, nearby code, and nearby tests;
- search for the exact feature, endpoint, function node, integration, incident, or file
  being changed.

Read `docs/PROJECT_OVERVIEW.md` when system ownership, product boundaries, or domain
responsibilities are relevant. Read `docs/ARCHITECTURE.md` for cross-module,
public-contract, integration, data-flow, or architectural changes. Read
`docs/README_DEPLOY.md` only for build, release, Node-RED import, runtime, staging,
cache-busting, or deployment work.

Do not read `docs/WORKLOG.md` from beginning to end by default. Search it by exact feature,
file, endpoint, function node, incident, date, commit, or integration and open only the
relevant entries.

Read specialized documents only when their domain trigger applies:

- `docs/NODERED_MODULAR_WORKFLOW.md` for Node-RED flow work;
- `docs/NODERED_REFERENCE.md` for relevant endpoint/function references;
- `docs/COMMUNITY_RATING_RECALCULATION.md` for rating or repair work;
- `docs/FCM.md` for push notification work;
- `docs/MAX_SUPPORT_SCENARIOS.md` and `docs/SUPPORT_DIALOGS_MAX.md` for support or MAX bot work.

## Commands

- Install: `npm install`
- Dev server: `npm run dev`
- Build all bundles: `npm run build`
- Build dev bundles: `npm run build:dev`
- Build academy bundle: `npm run build:academy`
- Lint: `npm run lint`
- Node-RED modular build: `npm run nodered:modular:build`
- Node-RED validate: `npm run nodered:modular:validate`
- Delivery routing/tests: `npm run ci:delivery:route`, `npm run test:delivery`
- Standard frontend release (owner-enabled workflow only): `npm run release:frontend:standard`
- Community rating tests: `npm run test:community-rating`
- Rating recalculation: `npm run rating:recalculate`
- Rating recalculation for all: `npm run rating:recalculate:all`
- Preview: `npm run preview`

## Global Rules

- Make minimal diffs.
- Do not reformat unrelated files.
- Do not revert user changes.
- Do not edit files in `secrets/`.
- Do not introduce new dependencies without explaining why.
- Prefer existing architecture, naming, utilities, and UI patterns.
- Use `rg` for search.
- Keep prod and dev bundle behavior aligned.
- Treat Tilda loader, `release.json`, Safari cache busting, and remote overlay loading as deployment-critical.
- Bug fixes should include regression tests when practical.
- New business logic should include tests when practical.
- If checks cannot be run, explain why in the final report.

## Frontend Rules

- Preserve the embedded-widget constraints: no assumptions about full-page ownership.
- Keep CSS scoped to the widget where possible.
- Every async UI should handle loading, error, and empty states.
- Components must work on mobile and desktop.
- Do not change business logic while doing UI-only work.
- Validate overlay module lifecycle: mount, unmount, close, and script loading.

## Node-RED Rules

- Prefer editing source functions in `scripts/nodered_*_nodes/` and patch/build scripts.
- Do not manually patch large Node-RED JSON files unless there is no safer source-driven path.
- For deployed LK Games / referral flows, treat the live Node-RED flow on server `147` as the source of truth before regeneration.
- Before an authorized real apply, pull a fresh live preimage into a new private external workspace with `nodered:modular:pull-147`, verify it, and use the focused source-driven patcher and reviewed contract.
- `sync-games-source`, `prepare-147` and `exports` are quarantined. Never regenerate tracked `node-red/modular/source.flow.json` as a shortcut to release.
- Preserve exact preimage guards, graph consistency, lock/lease, foreign-change protection and guarded rollback. Unified subscription enforcement is one graph; never substitute a sequence of partial wrappers.
- Local source/fixture checks need no live pull. Reuse unchanged packet source/candidate/results; refresh live preimage and conditions at real apply, not on every documentation or frontend task.
- Document touched endpoints, function nodes, and import/export files.

## Data And Rating Rules

- Use dry-run first for repair scripts.
- Preserve postcheck outputs for destructive or corrective data operations.
- Rating changes should run `npm run test:community-rating` when possible.
- Be explicit about date ranges, station IDs, game IDs, and affected records.

## Git Discipline

- Work on focused branches when possible.
- Do not commit unrelated changes.
- Do not amend commits unless explicitly requested.
- Final reports must list changed files, checks run, and residual risks.

## Delivery by changed operation

Ship one small independently releasable outcome from a short-lived focused branch/worktree.
Start from current `origin/main`, preserve existing dirty work, implement and check the scope,
commit, publish the task branch and open/update its PR without intermediate permission stops.
Draft means unfinished work; mark it ready when the scoped result and checks are complete.
Independent features need no integration package. Record unrelated improvements separately.

| Route | Changed operation | Checks and review |
| --- | --- | --- |
| FAST | Presentation, text, layout, navigation, filters, UI states, reads through an existing authorized contract without changing authority | Self-review and relevant lint/typecheck/build, UI/loading/error checks and regressions |
| SAFE | Reversible business behavior without money, access, booking/capacity, irreversible data or external writes | Affected behavior/negative checks; another reviewer only for a concrete uncertainty |
| CRITICAL | Purchases, debits, calculated discounts, booking/capacity, authorization, secrets, migrations, external writes, release mechanism | Specialist review of actually changed risks, compatibility/recovery and applicable full CI |

A subscription label or CSS edit is presentation; a purchase handler is critical. Classify the
operation, not the module's name. Using the already approved release mechanism does not require
reviewing its design again; changing that mechanism does. Unknown executable code expands CI;
labels cannot downgrade checks. Automated standard frontend eligibility is deliberately narrower
than human FAST: CSS and literal native-element JSX presentation only. Other FAST/SAFE code uses
the business check contour until a reviewed operation-specific classifier covers it.

Main movement alone does not invalidate checks whose actual inputs are unchanged. Check the
integrated source before release. PR CI checks the exact head; push CI checks the integrated
main; publication builds its production configuration and checks provenance, hashes and smoke
without replaying the same full regression matrix. A changed input requires fresh evidence.

## Authority and activation

Before owner activation, merge and live execution require explicit authority. This infrastructure
PR cannot merge or deploy itself. Editing these instructions grants no new session authority.
The owner's single activation approves only the boundaries in `docs/FRONTEND_DELIVERY.md`:
ready eligible PR -> protected merge -> integrated checks -> complete static frontend artifact ->
existing upload -> atomic publication -> smoke/observation or guarded return. Once enabled,
those unchanged steps do not request separate manual approvals. Missing protection, source
identity, bootstrap or access blocks that release, not unrelated development.

CRITICAL releases use one explicit approval naming source, scope, target, ordered operations,
verification, stop signal and recovery. That approval covers the named unchanged sequence,
including its guarded recovery; scope or material-condition drift needs a new decision.
Production data, payment/provider operations, imports/restarts, migrations, secrets, ACL and
routing never become authorized merely by a green CI or by this frontend activation.

For every feature state briefly: owner, audience, observed result, stop signal and stop method.
Use existing flags only when useful. Disabling a flag does not undo past external operations.
One product and one working end-to-end scenario can be an initial subscription release;
all products/scenarios are not an implicit readiness condition. Product rules are unchanged.

Blocking findings must name the concrete consequence, how it could occur, and the minimum
condition for continuing. Missing mandatory access/configuration can be that condition; an
already observed incident is unnecessary. Avoid speculative all-platform acceptance work.

## Review and report

No mandatory architect/implementer/tester/reviewer chain. The primary owns implementation.
FAST uses self-review; SAFE adds a reviewer only when justified; CRITICAL uses the specialist
for the touched trust boundary (security, payment safety, release, migration or reliability).
Review is read-only by default. Re-review only the corrected diff and affected properties.
Never have two writers in the same files; preserve others' branches and worktrees.

Report changed files and commands, checks actually run, skipped evidence, concrete residual
risks and whether commit, task-branch push, PR, merge, deploy or live mutation occurred.
Report exactly one executor route: `MODEL_ROUTE: parent`, `MODEL_ROUTE: global_spark_worker`
or `MODEL_ROUTE: Spark fallback`. Pilot target: a small FAST feature ships within the working
day and waits minutes after readiness. Measure this; do not promise it or make it a new gate.

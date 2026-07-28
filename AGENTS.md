# AGENTS.md

## Project

PadlHub LK is a React 19 + TypeScript + Vite widget for Tilda.
The project includes:

- IIFE frontend bundles for the cabinet and overlay modules.
- Node-RED backend flows for games, chats, communities, support, MAX bot, and payments.
- VivaCRM, Keycloak, SERV2, Firebase/FCM integrations.
- Community rating, recalculation, and data repair scripts.
- Android/Capacitor wrapper artifacts.

## Read First

Before making non-trivial changes, read:

- `docs/PROJECT_OVERVIEW.md`
- `docs/ARCHITECTURE.md`
- `docs/README_DEPLOY.md`
- `docs/WORKLOG.md`

For focused areas also read:

- `docs/NODERED_MODULAR_WORKFLOW.md` for Node-RED flow work.
- `docs/NODERED_REFERENCE.md` for Node-RED endpoint/function references.
- `docs/COMMUNITY_RATING_RECALCULATION.md` for rating and recalculation work.
- `docs/FCM.md` for push notification work.
- `docs/MAX_SUPPORT_SCENARIOS.md` and `docs/SUPPORT_DIALOGS_MAX.md` for support/MAX bot work.

## Commands

- Install: `npm install`
- Dev server: `npm run dev`
- Build all bundles: `npm run build`
- Build dev bundles: `npm run build:dev`
- Build academy bundle: `npm run build:academy`
- Lint: `npm run lint`
- Node-RED modular build: `npm run nodered:modular:build`
- Node-RED validate: `npm run nodered:modular:validate`
- Node-RED exports: `npm run nodered:modular:exports`
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
- Before rebuilding modular Node-RED artifacts for release, pull the current live flow from `147` into `node-red/modular/source.flow.json`; do not build from a stale local snapshot.
- Preferred command for release prep: `npm run nodered:modular:prepare-147 -- /absolute/remote/flows.json`.
- After Node-RED changes, run `npm run nodered:modular:validate` when possible.
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

## Agent Roles

### 1. Architect / Planner

Use for new features, architecture changes, large refactors, and risky Node-RED/API changes.

Prompt:

```text
Ты архитектор проекта PadlHub LK.
Сначала изучи структуру репозитория, AGENTS.md, package.json, docs/PROJECT_OVERVIEW.md, docs/ARCHITECTURE.md и существующие паттерны.
Не пиши код сразу.
Составь план:
1. какие файлы менять,
2. какие риски есть,
3. какие альтернативы,
4. какие тесты нужны.
После плана жди подтверждения или явно отдели план от реализации.
Учитывай React 19 + TypeScript + Vite IIFE bundles для Tilda, Node-RED flows, VivaCRM/Keycloak/SERV2 integrations и community rating scripts.
```

### 2. Feature Implementer

Use as the default coding agent.

Prompt:

```text
Ты основной implementer проекта PadlHub LK.
Реализуй задачу минимальными изменениями.
Следуй существующей архитектуре, стилю и неймингу.
Не переписывай лишние файлы.
Не трогай secrets и чужие незакоммиченные изменения.
Для frontend учитывай Tilda widget constraints, overlay bundles, mobile layout и async states.
Для Node-RED правь source functions/patch scripts, а не большие JSON вручную, если есть безопасная альтернатива.
После изменений запусти линтер/тесты/сборку, если это возможно.
В конце дай краткий список изменённых файлов, что изменилось, какие проверки запущены и какие риски остались.
```

### 3. Debugger

Use for bugs, regressions, payment/API/rating incidents, and production-like issues.

Prompt:

```text
Ты debugger проекта PadlHub LK.
Найди причину бага, не исправляй вслепую.
Сначала:
1. воспроизведи проблему или объясни, почему не можешь,
2. найди минимальную причину,
3. предложи исправление,
4. добавь регрессионный тест, если это практично.
Меняй минимальное количество кода.
Для API/интеграций проверяй контракты VivaCRM, Keycloak, SERV2 и реальные payload/status handling.
Для Node-RED проверяй соответствующие function nodes, MongoDB запросы и response nodes.
```

### 4. Test Engineer

Use after implementation of business logic, ratings, repair scripts, API mappers, and bug fixes.

Prompt:

```text
Ты test engineer проекта PadlHub LK.
Изучи изменённую логику и существующий стиль тестов.
Добавь тесты на:
- основной успешный сценарий,
- edge cases,
- ошибки/валидацию,
- регрессии.
Не меняй production-код, кроме случаев, когда он явно нетестируемый.
Если production-код нужно изменить ради тестируемости, сначала объясни почему.
Для community rating запускай npm run test:community-rating.
Для Node-RED проверяй npm run nodered:modular:validate, если изменение затрагивает flows.
```

### 5. Reviewer / Critic

Use after meaningful diffs, preferably in a fresh session.

Prompt:

```text
Проведи строгий code review diff проекта PadlHub LK.
Ищи только существенные проблемы: баги, edge cases, безопасность, производительность, нарушения архитектуры, деплойные риски.
Не придирайся к стилю, если он не ломает читаемость.
Для каждой проблемы дай:
- файл и место,
- почему это проблема,
- как исправить.
Особое внимание: Tilda widget constraints, overlay lifecycle, release files, Node-RED flow consistency, payment flows, rating recalculation, secrets leakage.
Если существенных проблем нет, так и скажи, но перечисли остаточные риски и непокрытые проверки.
```

### 6. UI/UX Frontend Agent

Use for visual states, responsive layout, accessibility, frontend polish, and user flows.

Prompt:

```text
Ты frontend/UI агент проекта PadlHub LK.
Проверь компонент или экран с точки зрения UX:
- responsive layout,
- loading/error/empty states,
- accessibility,
- keyboard navigation,
- визуальная консистентность,
- embedded Tilda widget constraints.
Исправь только то, что относится к UI/UX.
Не меняй бизнес-логику, API-контракты и Node-RED flows.
После правок проверь мобильный и desktop сценарии, если возможно.
```

## Recommended Workflows

New feature:

```text
Architect / Planner -> Feature Implementer -> Test Engineer -> Reviewer / Critic
```

Bug:

```text
Debugger -> Feature Implementer -> Test Engineer -> Reviewer / Critic
```

UI-only task:

```text
UI/UX Frontend Agent -> Reviewer / Critic
```

Node-RED or integration change:

```text
Architect / Planner -> Feature Implementer -> Test Engineer -> Reviewer / Critic
```

## Final Report Template

Every agent should finish with:

```text
Changed files:
- path: what changed

Checks run:
- command/result

Risks:
- remaining risk or "none known"
```

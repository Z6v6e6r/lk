# Current System Map

This is the first current-state architecture map for PadlHub LK. It is based on
local project docs and known runtime patterns, not a fresh live production audit.

## Executive Summary

PadlHub LK is currently a mixed architecture:

- React 19 + TypeScript + Vite IIFE bundles embedded into Tilda.
- Standalone public bundles for games, tournaments, group schedule, communities,
  onboarding, levels, and subscription/referral entrypoints.
- Node-RED/SERV2 backend flows for games, chats, communities, support, MAX,
  analytics, payments, and tournament-related workflows.
- VivaCRM and Keycloak/Viva auth still own important source-of-truth contracts.
- MongoDB stores local LK state, read models, support data, game state, tournament
  state, communities, rating facts/snapshots, and operational artifacts.
- Scripts perform repair, reconciliation, rating recalculation, deployment, and
  Node-RED modular artifact generation.

The migration goal is not to rewrite all of this at once. The first goal is to
put a stable API boundary in front of it.

## Current Entrypoints

| Entrypoint | Current form | Runtime owner | Notes |
|---|---|---|---|
| Cabinet | Tilda `/lk_new` + `bundle.js` | React IIFE + Viva/Node-RED | Main user surface. |
| Game invite | `/game_join?joinGame=...` | React + games bundle | Guest/auth/join path. |
| Game create | `/game_create?...` | React + games bundle | Public quick create path. |
| Find game | `/finde_game` | `games.js` | Public open games list. |
| Group schedule | `/group` / embedded page | `group-schedule.js` + Viva | Standalone group trainings. |
| Tournaments | Tilda + `tournaments.js` / `tournament-signup.js` | React + Node-RED + Viva | Signup, manager, results. |
| Communities | `communities.js` and cabinet section | React + Node-RED | Community feed/rating UI. |
| ЦУП/support | support/admin flows | Node-RED + Mongo | Operator workflows. |
| Android wrapper | Capacitor | React web bundle | Current app wrapper, not independent API. |
| iOS wrapper | Capacitor | React web bundle | Planned/partial wrapper. |

## Current Runtime Blocks

| Block | Current role | Migration note |
|---|---|---|
| Tilda loaders | Load correct LK bundle and release manifest | Keep as web shell, but do not expose mobile contract through Tilda logic. |
| LK static host | Serves bundles, fonts, release manifests | Move to CDN/object storage later. |
| React frontend | UI and some business pre-checks | Move business decisions behind `/api/v1`. |
| Node-RED | HTTP backend, integration glue, Mongo queries | Freeze behind legacy adapter, then replace domain by domain. |
| MongoDB | Flexible state/read models | Keep initially; introduce Postgres for transactional core. |
| VivaCRM | Bookings, exercises, subscriptions, profile data | Wrap behind Viva adapter; gradually duplicate needed functions. |
| Auth | Keycloak/Viva auth contracts | Wrap behind identity API and stable session contract. |
| Payments | Callback, sync, reconciliation | Move early to transactional Postgres-backed module. |
| MAX/Support | Messaging and operator dialogs | Keep separate domain and data boundary. |
| Firebase/FCM | Push notifications | Add device registry and APNS-ready notification service. |
| Repair scripts | Operational fixes and recalculations | Convert repeatable repairs into jobs/workers with audit. |

## Migration Boundary

Target first boundary:

```text
Web/Tilda + Android + iOS
        |
        v
PadlHub API / BFF `/api/v1`
        |
        +-- legacy Node-RED adapter
        +-- VivaCRM adapter
        +-- Mongo legacy read/write adapter
        +-- new Postgres transactional modules
```

This lets mobile apps start against a stable API while old internals are still
being replaced.

## Current Pain Points To Capture

- Business logic is split between React, Node-RED functions, Viva behavior, and scripts.
- Some flows rely on local Mongo state instead of rechecking Viva state.
- Node-RED live flow can drift from local generated artifacts.
- Static bundle fallback and runtime API fallback are separate problems.
- Write operations need a clear write-primary decision during failover.
- Payment/subscription invariants are too risky to keep only as document updates.
- Mobile apps need stable contracts and should not inherit Tilda/Node-RED shapes.

## Target First Slice

Start with:

1. `/api/v1/health`
2. `/api/v1/me`
3. `/api/v1/devices`
4. `/api/v1/games` read-only
5. OpenAPI and contract tests

This gives mobile clients and web a stable entrypoint without touching the
highest-risk write paths first.

# Integration Inventory

| Integration | Direction | Current use | Risk | Target treatment |
|---|---|---|---|---|
| VivaCRM Admin/End-user APIs | LK -> Viva | Profile, exercises, bookings, subscriptions, cancellations | External source of truth; contract differences between flows | Typed Viva adapter with retries, audit, and contract tests |
| Keycloak / Viva auth | LK -> Auth | SMS auth, tokens, refresh | Token TTL/session behavior affects all entrypoints | Identity facade and stable mobile session contract |
| Payment provider | User/Provider -> LK | Purchase flow, return URL, confirm/reconcile | Duplicate callbacks, user not returning, pending states | Payment service with idempotency keys and outbox |
| MAX API | MAX -> LK -> MAX | Support bot and operator replies | Identity mapping can be incomplete | Support connector adapter with normalized channel identity |
| Firebase FCM | LK -> FCM | Web/Android push | Token lifecycle and user-device binding | Notification service; add APNS-ready interface |
| Tilda | User -> Tilda -> LK | Web shell and loader | HTML can drift from repo; bootstrap config affects runtime | Keep web shell, move product contract to API |
| Static LK host | Browser -> Host | JS bundles, fonts, release manifests | Static fallback does not guarantee API fallback | CDN/object storage with explicit API base config |
| MongoDB | LK -> DB | Current local LK state/read models | Flexible but weak business invariants if unchecked | Keep legacy/read models; add Postgres transactional core |
| Node-RED | Browser/API -> Node-RED | HTTP backend and automation | Live flow can drift from generated artifacts | Legacy adapter; domain-by-domain replacement |

## Rules For Integration Diagrams

- Mark all external writes.
- Mark retry/idempotency behavior.
- Mark current and target source of truth separately.
- Do not put secrets, raw payloads, or real client identifiers in diagrams.

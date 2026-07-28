# Domain Inventory

This file tracks the current domain map and the target migration boundary.

| Domain | Current owner | Current data | Critical invariants | Target owner |
|---|---|---|---|---|
| Identity/Profile | React, Viva/Keycloak, VivaCRM | Viva profile, auth tokens, browser storage | One real user identity per phone/client; stable session restore | Identity service / API BFF |
| Devices/Push | React, Firebase/FCM, Node-RED | Device tokens, push registrations | Token belongs to authenticated user; logout deactivates token | Notification service |
| Bookings | VivaCRM + React helpers | Viva bookings, local derived state | Booking/cancel must be idempotent and auditable | Booking service with Viva adapter |
| Subscriptions | VivaCRM + React/Node-RED guards | Viva subscriptions, local sales/limits | No double-spend; correct product/date/limit handling | Subscription usage module in Postgres |
| Games | React games bundle + Node-RED + Mongo | `lk_games`, chats, split payments, result snapshots | Roster, join/leave, payment, result state must stay consistent | Games service |
| Group schedule | `group-schedule.js` + Viva | Viva exercises/timetable | Public schedule and booking rules match Viva | Booking/group module |
| Tournaments | React tournaments + Node-RED + Mongo + scripts | tournaments collection, standings, rounds, results | Round/result layout cannot be lost; standings must be reproducible | Tournament service |
| Payments | Frontend sync + Node-RED + payment provider | sales, payment refs, pending states | Confirm once; callbacks idempotent; reconcile background failures | Payment service |
| Support/ЦУП | Node-RED + Mongo + MAX | support_clients, dialogs, messages, outbox | Connector identity must be preserved; operator audit | Support service |
| Communities | React + Node-RED + Mongo | communities, feed, joins | Membership/feed visibility; privacy | Communities service/read model |
| Community rating | TS scripts + Mongo + partial Node-RED | facts, aggregates, snapshots | Facts are reproducible; recalculation is auditable | Rating worker/service |
| Recommendations | Not yet stable | future feature data | Must not mutate core state directly | Recommendation service/read model |
| Admin/Repair | Scripts and manual ops | tmp reports, Mongo changes, Viva repair calls | Dry-run first; postcheck evidence | Admin jobs with audit |

## Migration Rule

Start by wrapping current owners behind `/api/v1`. Replace internals only after
the API contract is stable and covered by tests.

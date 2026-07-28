# Endpoints To Map

This list is intentionally incomplete. It is the first pass for mapping current
traffic into future `/api/v1` contracts.

## Current Public/LK Endpoints

| Area | Current endpoint shape | Target API group |
|---|---|---|
| Games list | `/lk/games`, `/lk/games/by-phone`, `/lk/games/:id` | `/api/v1/games` |
| Game create/join/leave | `/lk/games/*` split routes | `/api/v1/games/{id}/...` |
| Game chat | `/lk/game-chat/*` or support chat variants | `/api/v1/games/{id}/messages` |
| Tournament list/signup | `/lk/tournaments/*`, public signup routes | `/api/v1/tournaments` |
| Tournament results | result lifecycle routes | `/api/v1/tournaments/{id}/results` |
| Group schedule | Viva exercise/timetable APIs and LK wrappers | `/api/v1/group-schedule` |
| Support | `/api/support/*` | `/api/v1/support` |
| Push | `/lk/push/*` | `/api/v1/devices`, `/api/v1/notifications` |
| Analytics | `/analytics/events`, `/lk/analytics/events` | `/api/v1/events` or internal collector |
| Payments | confirm/reconcile/status routes | `/api/v1/payments` |
| Subscriptions | sale/status/confirm routes | `/api/v1/subscriptions` |

## Mapping Steps

1. For each endpoint, capture method, path, caller, auth requirement, request, response, DB writes, external calls.
2. Mark read-only vs mutation.
3. Mark source of truth.
4. Mark whether mobile needs it.
5. Design stable `/api/v1` response independent of Node-RED/Mongo shape.

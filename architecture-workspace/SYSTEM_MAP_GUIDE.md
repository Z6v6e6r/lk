# How The Current System Map Should Look

The current system map should not be a single huge diagram. It should be a set
of connected views, each answering one question.

## View 1: System Context

Question: who uses PadlHub LK and which external systems does it depend on?

Must show:

- Web users on Tilda/LK.
- Future Android and iOS clients.
- Admin/operators in ЦУП.
- LK frontend bundles.
- Node-RED/SERV2 backend.
- VivaCRM.
- Keycloak/Viva auth.
- MongoDB.
- Payments.
- MAX.
- Firebase/FCM and future APNS.
- VK Cloud target platform.

## View 2: Container View

Question: what deployable/runtime blocks exist today?

Must show:

- Tilda pages and loaders.
- Static LK bundle server.
- React IIFE bundles.
- Node-RED tabs/flows.
- Mongo collections.
- Repair/recalculation scripts.
- Android/Capacitor wrapper.
- External integrations.

## View 3: Domain Ownership

Question: which business domain owns which data and actions?

Domains:

- Identity and profile.
- Bookings and subscriptions.
- Games.
- Group schedule.
- Tournaments.
- Payments.
- Support and ЦУП.
- Notifications.
- Communities and rating.
- Recommendations.
- Admin/repair operations.

Each domain should include:

- Current owner: frontend, Node-RED, Viva, script, Mongo, or mixed.
- Current source of truth.
- Critical invariants.
- Migration target.

## View 4: Key Runtime Flows

Question: how does data move in real user flows?

Start with these flows:

- Login and session restore.
- Cabinet bootstrap.
- Open games list.
- Create/join/leave split game.
- Group training booking.
- Tournament signup and result save.
- Payment callback and reconciliation.
- Support dialog and MAX response.
- Push registration and delivery.
- Community rating recalculation.

## View 5: Deployment And Failover

Question: what happens when primary infrastructure is blocked or unavailable?

Must show:

- Current primary LK host.
- Current reserve/dev host.
- Static bundle failover.
- Runtime API fallback.
- Writes that must not silently fall back without a write-primary decision.
- Target VK Cloud parallel contour.

## Visual Convention

Use colors/tags consistently:

- `current` - exists today.
- `legacy` - exists but should be replaced.
- `external` - VivaCRM, Keycloak, payments, MAX, Firebase.
- `target` - future API/backend component.
- `risk` - hard dependency or known unstable contract.

## Done Criteria

The first map is useful when a new developer can answer:

- Where does a request enter the system?
- Which component writes the state?
- Which DB/collection/table stores it?
- Which external API can block the flow?
- What can be migrated without changing the user contract?

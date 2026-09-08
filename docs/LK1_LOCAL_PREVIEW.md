# Local LK1 Docker preview

Owner: current LK1 development task. Audience: local UI development on this Mac.
Source: the task branch based on fetched LK1 `origin/main`, not the older primary checkout.

Run `npm run local:up` from this worktree, then open http://127.0.0.1:5180.
Edits to `src` are picked up by Vite. `npm run local:status` reads container health;
`npm run local:stop` stops only this Compose project. Other LK2 projects are not touched.

## Current boundary

This preview supports **Yandex/SMS login and production data read-only**. Sending a code
and exchanging/refreshing credentials are explicitly authorized authentication
exceptions. Only the user initiates login for their existing account. Yandex is
started by the outer shell button; other OAuth providers and phone-number
registration/verification remain disabled. Payments, invitations, bookings,
profile changes, consent synchronization, push registration and analytics writes are
blocked independently of UI behavior. A visible banner identifies this boundary.

The Vite container is attached only to an internal Docker network. A separate small
entry container exposes loopback port 5180 and forwards only to the fixed `web:5173`
target. A separate route-enum gateway in that entry container can reach only fixed
Viva/Keycloak templates; it has no arbitrary upstream or CONNECT support. This
entry network is needed because Docker Desktop does not publish the internal-only
Vite network directly. Both containers run as `node` with a read-only filesystem, no capabilities,
no Docker socket, and no production environment or credential mounts. Only package
manifests are sent to the dependency image build. Source directories are mounted
read-only; caches are bounded temporary filesystems. Production Vite config is not used.
The ARM64 image installs the Linux ARM64 Rollup binary at the existing locked Rollup
version, matching the repository CI's explicit Linux x64 optional-dependency repair.
The root dependency manifest and lock are not changed by that image-only repair.

Browser CSP blocks external scripts, connections, images, forms, workers, and frames.
The application is inside a local frame that cannot open popups or navigate the top
page; external frame navigation is blocked. A pre-bootstrap guard returns an explicit
local error for unapproved fetches and blocks other write transports. Approved
requests become same-origin JSON POST envelopes containing a route enum and validated
fields, never an upstream URL/method/header set. The gateway requires the exact local
Host and Origin, a custom header, JSON content type and a bounded body; cross-site
requests and preflights are denied. The Vite hop still rejects non-GET/HEAD requests.

The local `/__lk1_local/status` endpoint reports only mode and aggregate authentication,
read, blocked and upstream-failure counters. It never records URLs, request bodies,
tokens, profiles or personal data. Provider requests have a timeout, bounded response
size, no redirects/retries, a concurrency bound and a temporary failure circuit.

## Account and credential boundary

The gateway binds SMS token exchange to a recent successful challenge and limits code
requests across sessions plus OTP attempts per challenge. Tokens arrive directly from
the fixed Keycloak endpoint over TLS. Issuer, client, subject, expiry and phone are
checked; an authenticated Viva profile must confirm the same phone and a stable profile
ID before login or refresh completes. The anonymous HttpOnly/SameSite cookie rotates
on login. Logout deletes only the local session, without provider revocation.

Real access/refresh tokens stay in process memory. The existing frontend receives a
synthetic local display JWT and an opaque refresh handle bound to its HttpOnly cookie.
They cannot be used at Viva. The display JWT contains a random local subject and a
non-personal phone marker. Analytics profile/visit/pending storage, phone-keyed referral
windows, pending consent queues and client-keyed community order/read markers are cleared and suppressed before
app bootstrap. Stopping/restarting the entry container drops all authenticated sessions;
sign in again after a restart. Sessions expire after at most eight hours.

The ingress never forwards cookies or bearer/proxy authorization headers into Vite,
including during HMR. Existing real credentials in this origin's two auth storage keys
are removed before bootstrap. Browser-readable auth cookies are virtualized: foreign
host-wide cookies from other localhost ports remain untouched and invisible to this
app; the app's auth-cookie writes/deletes affect only its memory map. Synthetic handles
in origin-specific storage support page reloads while the gateway session remains valid.

Allowed business reads are exactly the current user's Viva profile, active bookings,
booking history, subscriptions and studios. Tenant and upstream credentials are fixed
server-side; arbitrary client IDs, phone filters, detail IDs, extra query parameters and
other methods are rejected. SERV2 game projections, advertising, remote assets and
third-party participant data are not connected, so those sections may be incomplete.

Run `npm run test:local-preview` for the local boundary tests. Fixture tests and a healthy
login screen do not prove a real-account session; authenticated production reads require
the user's manual login and an explicit runtime observation without logging PII.

Stop signal: any unexpected external request or enabled business command. Stop with
`npm run local:stop`. Stopping the container removes no other task's services or data.

## Yandex local sign-in

Use **Войти через Яндекс** in the outer local header. This uses the existing Viva
Keycloak broker (`clients`, client `widget`, tenant `iSkq6G`, fixed `kc_idp_hint=yandex`,
`prompt=login`, scope `openid`). It does not create a separate Yandex application or
change the production frontend. The iframe's provider buttons remain disabled and its
sandbox is unchanged. The outer shell alone navigates to the fixed authorization URL.

State and PKCE S256 verifier are random, server-memory-only and expire in ten minutes.
The fixed callback URI is exactly:

`http://127.0.0.1:5180/lk_new?authMode=viva`

The ingress serves a static callback document only for a bounded top-level GET with
unique recognized parameters. No callback URL reaches Vite; code/state/provider error
text are never reflected or logged. The callback script clears the URL, then uses a
same-origin POST with the Strict HttpOnly cookie. State is consumed before the first
await; retries, foreign/expired sessions and client-selected redirect/verifier values
are rejected. Token exchange and canonical profile confirmation happen on the server;
only synthetic local handles reach origin-local storage. A missing phone claim fails
closed and prompts the user to use SMS or complete linking separately in the real LK.
The preview never invokes phone verification/linking commands.

Manual verification after restoring network access (for example, the user disables VPN):

1. Open the exact loopback URL above via the root `http://127.0.0.1:5180/` in Chrome.
2. Click the outer Yandex button and deliberately select your existing linked account.
   Use a separate browser profile if the browser holds someone else's identity session.
3. Complete the provider's own UI, then check return to local LK and profile/bookings.
4. If Keycloak reports `Invalid parameter: redirect_uri`, its client owner must confirm
   or separately authorize adding the exact callback URI. This repository does not
   administer the provider's redirect allowlist. Do not use wildcard redirects.
5. If the callback reports a network error, begin a fresh login after restoring access:
   authorization codes are single-use and ambiguous exchanges are never retried.

Provider reachability, redirect registration, Yandex broker claim mapping and real-account
callback are **NOT_RUN** until that manual check. `prompt=login` requests fresh login;
the broker's actual propagation/account-selection behavior is not locally proven.
The fixed provider hint is not a cryptographic assertion of the upstream Yandex identity.
A first brokered login may create/link an identity according to Keycloak's existing
realm flow; this is an authentication effect, separate from the blocked business writes.
No such live login or identity change is performed by automated tests. The user handles
any account-linking or provider consent screen themselves.

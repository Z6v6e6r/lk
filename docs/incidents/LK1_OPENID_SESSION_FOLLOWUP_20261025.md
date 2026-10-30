# Viva sessions without openid — 2026-10-25

Status: source fix prepared. No login, refresh, consent write, provider/configuration
change or production deployment was performed during this investigation.

## Evidence and attribution

Read-only production diagnostics after PR229 observed 27 consent-verification
failures with upstream 403 / insufficient_scope. Unverified diagnostic flags
reported openid absent, token not expired by claim, and expected clients-realm
issuer/widget client. These flags do not verify a token or identify its source.
The auth function hashes were checked again and remained unchanged.

Tracked history shows that the clients-realm Viva SMS password request first
added scope=openid in PR214 (21 October, e4a36cf8). Earlier Viva SMS requests
omitted it. OAuth already requested openid. Stored access tokens were adopted
without compatibility checks and refresh inherited the old grant without an
explicit scope. Thus pre-PR214 SMS grants plus retained sessions are a concrete
source path matching the observed realm/client. Synthetic tests reproduce the
old-session acceptance; individual production tokens cannot be attributed to
that path from the available aggregate diagnostics.

A separate current password request in LegacyAuthProvider also omitted openid,
but its prod realm does not explain the observed clients-realm flags. Close that
omission without changing its realm. Shared storage additionally accepted any
cookie name ending in AuthToken/RefreshToken and canonical-name prefix lookalikes.
That could select another embedded application's session; no evidence proves
that this happened for any of the 27 events. Public /lk_new HTML contained no
inline token-request code; other pages and external callers remain unverified.

## Prepared behavior

- Read only exact canonical credential cookies, then canonical nonexpired local
  storage, then exact current-tenant legacy cookies. Preserve tenant compatibility
  and ignore arbitrary suffix/prefix names; never delete foreign cookies.
- In Viva, explicit incompatible scope, issuer, client or tenant hints trigger
  reauthentication. Missing scope/tenant claims remain unknown. JWT decoding here
  is an unverified UX compatibility check; backend/provider authorization remains
  authoritative and no permission is granted by these checks.
- Validate fresh SMS/OAuth/refresh access tokens before persisting or syncing
  consent. Refresh preserves the original grant scopes rather than downscoping
  profile/phone/email. A returned missing-openid token or invalid_scope requires
  a new login; refresh cannot be assumed to upgrade an old grant.
- Reject refresh subject changes and ignore stale refresh responses after a newer
  session replaces the original credential pair. Cancel the old refresh timer.
- Incompatible-session cleanup removes credentials only, retaining pending
  payments and consent evidence. OAuth may replace an old incompatible cookie;
  normal social phone-completion behavior remains supported.

## Acceptance and limits

Regression tests cover old sessions, fresh bad responses, refresh scope and
subject changes, stale responses, refresh-only restore, OAuth replacement and
consent preservation, canonical/current-tenant cookie priority and cleanup.
Source checks do not prove provider acceptance or eliminate all historical
401/403 causes. A future separately authorized release needs a fresh production
preimage, production build manifest and public/UI acceptance. Real provider
login/refresh and correlation of newly issued tokens remain unperformed; no
raw token, claim body, private identifier or credentials were exported.

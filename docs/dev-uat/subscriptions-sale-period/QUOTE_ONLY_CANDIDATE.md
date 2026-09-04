# Provider-independent QUOTE_ONLY candidate

## Scope

This local candidate demonstrates the sale-period boundary without VivaCRM, MongoDB,
Node-RED, booking, payment, entitlement mutation, or browser-supplied subject data. It
binds an exact LK policy evaluator and the exact ph-admin sale-period resolver source.
The builder reproducibly compiles that exact resolver with the pinned TypeScript version;
the runtime executes both source-derived evaluators in capability-restricted VM contexts,
then evaluates two immutable server-owned synthetic subjects:

- A was purchased one millisecond before the V2 boundary and resolves to V1/free.
- B was purchased exactly at the V2 boundary and resolves to V2/50% discount.

The only HTTP surface is
`GET /api/internal/subscriptions/dev-uat/quote-comparison` on `127.0.0.1:3040`.
Query strings, request bodies, and alternate methods are rejected. Standard manual UAT
remains `BLOCKED`.

## systemd 245 start custody

The unit uses the systemd-245-supported
`StandardInput=file:/srv/lk1-subscription-dev/authorization/quote-start.approved`.
PID 1 opens the root-owned `0600` marker in its root-owned `0700` directory before
dropping to `lk1-subscription-dev`. Without attempting to traverse that root-only
directory, the runtime validates FD 0 using its exact `/proc/self/fd/0` target,
`fstat`, ownership, mode, link count, read-only flags, bounded size, immutable stat
tuple, exact authorization schema, artifact/source digests, role, and a maximum
one-hour lifetime. The future install identity/start authorization must additionally
bind the exact Node executable SHA-256 and `process.version`; the runtime rejects any
other executable path, bytes, or version. It also terminates at authorization expiry;
the unit has `RuntimeMaxSec=3600` and `Restart=no`.

`EnvironmentFile` contains installed artifact identity only. It is not start
authorization. There is no root helper, shell hook, `LoadCredential`, `[Install]`
section, or write path.

## Local build and verification

Run only from a clean checkpoint that contains exact LK main and with a clean ph-admin
checkout at exact ph-admin main:

```bash
node scripts/build_lk1_subscription_quote_only_candidate.mjs \
  --output /private/tmp/lk1-subscription-quote-only-<checkpoint> \
  --lk-source-commit <exact-lk-main-sha> \
  --ph-admin-repository <absolute-clean-ph-admin-worktree> \
  --ph-admin-source-commit <exact-ph-admin-main-sha>
```

The output is source-only. It deliberately contains no installer, authorization marker,
identity environment file, service activation command, secrets, provider client,
Node-RED flow, Mongo client, or write executor. Building or verifying it grants no
authority to install, reload systemd, start/enable the service, expose ingress, use
canary IDs, call VivaCRM, or write any external state.

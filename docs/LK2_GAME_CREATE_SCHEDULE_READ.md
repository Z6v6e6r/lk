# LK1 schedule reader for LK2

The read service runs separately on the LK1 host with a fixed IPv4 loopback
listener. It reuses the same parsing, station mapping, limits and account
checks as the QA endpoint. It does not load or restart Node-RED.

Timeweb calls the tracked #491 GET path through the exact nginx location. The
location accepts only the confirmed Timeweb LK2 egress address. The LK2
backend signs the exact GET query with its RS256 actor-delegation key and
forwards its short-lived Viva user token. The reader verifies the signature,
scope, tenant, actor, session, correlation and bearer hash before passing it to the
existing Viva read endpoints and returns only availability or a quote to LK2.
The underlying Viva timeslot read and LK1 price preview use POST as their
provider protocol. The public endpoint accepts only GET. It never reserves
a court, opens checkout or confirms a payment.

## Release inputs

- Freeze the reviewed LK1 commit and lockfile in a root-owned directory
  `/opt/padlhub/lk1-game-create-schedule/releases/<commit>`. Record the release
  contents and SHA-256 before switching the root-owned `current` symlink, and
  retain the previous symlink target for rollback. Include the tracked source
  dependencies and TypeScript 5.9.3 from the lockfile. The existing reader
  extracts the court mapping and price parser from those sources at startup.
- Rehearse the unit with disposable synthetic provider input and the exact
  locked checkout. Verify service startup, rejected methods, invalid bearer,
  ignored unrelated routes and the 15-second upstream deadline.
- Confirm the actual source address of Timeweb traffic on the LK1 ingress,
  the exact target vhost and that the loopback port is free. Capture the
  nginx and service preimages, preserve the vhost security headers and validate
  the candidate with `nginx -t`.
- Supply the existing delegation issuer, audience, key ID and public PEM as
  `LK2_BOOKED_OPERATION_DELEGATION_*` in the root-owned
  `/etc/padlhub/lk1-game-create-schedule-public.env`. Verify the public key
  fingerprint against the LK2 issuer. Keep the signing key in LK2 API custody.
- From the allowed Timeweb IP check that a bearer alone, a modified query and
  a signature for another scope all fail before the first Viva read.
- Under explicit activation authority, start the read process, verify loopback,
  then apply only the exact nginx location using the existing nginx custody
  procedure. Timeweb unauthenticated GET should return 401. An authenticated
  read should return real slots. An address outside the allowlist must be
  rejected. Keep the price preview result optional.
- Rollback removes the exact route using its saved nginx preimage, then
  stops the separate service. Confirm the prior ingress and Node-RED process.

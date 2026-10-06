# Mandatory admission CI

`lk1-exact-head` runs `check_b1_admission` for every business or release profile.
The existing final delivery reporter requires this check to succeed; a skipped
physical test, missing proof, failed cleanup, or nonzero runner exit fails the job.
The ordinary admission and fixture-negative suites also run in the critical matrix.

The workflow freezes the LK1 admission source, LK2 source and rehearsal helper blob.
The runner verifies the exact event HEAD, admission/#194-money/#196-owner-CI ancestry,
detached clean LK2 checkout and helper blob before locked installation and builds.
Update source pins only with the corresponding reviewed source and checks. This
workflow does not follow branch tips and does not use a credential for LK2 checkout.

Execution is restricted to GitHub-hosted Linux AMD64 with Node 22. The runner uses
immutable official Mongo/PostgreSQL digests, checks platform and runtime image IDs,
and refuses any existing fixture name, volume or loopback listener. Synthetic
credentials are generated privately. Containers are capped at 512 MiB, one CPU and
128 PIDs. PostgreSQL must be empty before exact-source migrations; the installed
migration ledger must match the source files. Fixtures may use at most 2 GiB and
the relevant filesystems must retain 5 GiB available.

The test exercises real session/authentication, PostgreSQL tenant isolation,
Mongo admission receipts and the SDK read. Its single PASS must have zero skips,
provider writes and business continuation. The CI receipt binds this invocation
to run/attempt, source/helper IDs, image IDs and an ownership nonce. The test's
literal LOCAL proof marker alone does not constitute CI evidence.

Cleanup reads fresh resource identities, removes only owned IDs/volumes, preserves
foreign replacements and continues after individual failures. It rejects remaining
listeners, processes, networks or fixed names. Process signals require a live owned
leader with matching Linux start time. Cleanup retains signal protection and a
bounded deadline; task temporary credentials, logs, checkout and cache are removed.
Only the sanitized result is published. No general prune, live data, provider call,
production migration, publication or deployment is part of this gate.

A passing automatic run is CI evidence for that exact source pair. It is separate
from production delivery and Android/device acceptance. Local physical execution
requires its own disposable fixture and resource authority.

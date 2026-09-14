# Local payment archive without a provider transaction

An explicit `paymentPolling.status: FAILED` is a local checkout archive, independent of the provider financial status. It must remain archived when a legacy sale has no `transactionId`.

Foreground confirmation stops at the archive gate and returns `archived: true`, `status: FAILED`, `paymentUrl: null`. A missing-transaction terminal response also applies the archive mapper. Recovery keeps the archive metadata and uses the existing hourly cooldown; a verified paid outcome still takes precedence. Unarchived dispatch recovery keeps its existing two-minute cooldown. This change does not release reservations, change payment identity or provider expiry, or infer that the provider transaction failed.

The historical `subscription_payment_polling_generation.json` is frozen. Its source hashes remain protected against standalone composition. `subscription_payment_archive_generation.json` declares the successor source hashes for four functions: confirm resolve, purchase router, atomic router and poll admission. The newest-source registry recognizes the successor while retaining earlier generations.

This source change does not deploy itself. The original polling candidate builder installs the initial polling topology and is intentionally not a successor updater. A deployment must read the current live flow, verify the four predecessor hashes, create a reviewed successor candidate that preserves the complete admission/CAS/response topology, and use the normal release preflight and rollback procedure. Do not force the original builder past its source-drift checks or replace a single function through a partial composer.

Validation: payment polling regression tests cover missing/null/empty transaction IDs, foreground and recovery after the archive cooldown, missing-transaction responses, paid precedence, unchanged ordinary recovery, and both generations of topology-dependent source hashes. Production data repair is a separate exact-record operation with protected preimages, dry-run, CAS, and read-back.

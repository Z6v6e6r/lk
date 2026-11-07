# Spanish individual/split training: installed-baseline frontend release

Owner authorized merge and deploy of PR #298 on 2026-11-07. Main merge is
529bde1fed33e2bf41948e0605b4664c0ddd5e62.

This release branch starts at the ACTUAL installed source
6b410c4f8253a85e2646679146078bf82794f941 (version 20261106T152148Z).
Main and installed source diverge; publishing full main would remove active FPR
features and introduce unrelated behavior. This branch ports only the four
frontend files needed for the Spanish individual/split subscription exclusion,
plus the same pure server predicate and focused regression/fixture updates.
The baseline group-only quote API stays intact; main's Patriots integration is
not imported. FPR modules and Node-RED runtime sources remain byte-identical to
the installed baseline.

The exact live Viva label was confirmed for direction 4480 on 2026-11-07.
The reviewed predicate matches that full label. Renaming or omitting it requires
updating the rule; no unverified direction ID is invented.

Production frontend uses lk-frontend-current with immutable 16-file release sets.
Publish only through existing inspect/acquire/upload/publish/smoke/finish guards;
keep previous whole-set rollback and verify public hashes and cache headers.
The backend is a separate focused fresh-flow candidate changing only booking and
preview function bodies; no records, subscriptions or payments are modified.

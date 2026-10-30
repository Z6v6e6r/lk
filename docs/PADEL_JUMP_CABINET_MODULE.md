# Cabinet Jump module on 147

The cabinet document stays on `https://padlhub.ru`. Only the explicit
`padelJumpRace=1` / `padelJump=1` route mounts `PadelJumpHost`; ordinary cabinet
visits must not import/download game code or station artwork.

The independent game build (`games/padel-jump/vite.config.ts`) publishes
`assets/cabinet.js` with `mount(target, mode)` and `unmount(target)`, alongside
standalone pages, shared hashed JS and external artwork. Its immutable namespace
is `/lk/padel-jump-team-<module source prefix>/` on 147. Module CSS is installed
only inside the mounted game generation and removed on unmount. Late imports
cannot mount after host cleanup; load failure offers an explicit retry.

Loading JS from `.su` does not navigate the document: the existing provider reads
only the current `.ru` session. No token/profile is passed to the module mount
interface, URL, fragment or message. Backend bearer verification, ACTIVE
membership, run ownership, CORS and idle deadlines remain unchanged.

Publish and verify the immutable backend/game namespace before activating the
cabinet reference. Pin the cabinet reference to the verified game source; unrelated
future cabinet releases must not silently select an unpublished game namespace.
The complete 16-file cabinet publication still uses its guarded pointer protocol.
On failure retain the old cabinet set and permanent game receipts; never revert
to a legacy pruning backend.

Release evidence includes ordinary-cabinet no-game network/size checks, actual
production module exports/assets/CSS, same-document existing/missing session
checks, practice/race, mount/unmount/remount, pending cleanup and retry. Browser
fixtures are LOCAL evidence; real phone tilt and authenticated live scoring are
separate acceptance steps.

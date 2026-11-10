# Rodina academy preview

Current public URL:
https://lk-reserve.89-108-64-209.sslip.io/lk/academy-preview/index.html

The published build7717cf89 has Rodina branding and still uses the primary Viva
tenant iSkq6G. The prepared tenant005JDA configuration and isolated backend are
not activated by building the project. Follow [ACADEMY_HANDOFF.md](ACADEMY_HANDOFF.md)
for the current build, backend, provider callback and deployment requirements.

## Release loading and recovery

`docs/academy-preview/index.html` pins the asset base to its own directory,
fetches `release-ffc-academy-dev.json` without cache and validates its version as
one safe path component. It loads `releases/<version>/ffc-academy-lk-dev.js`.
`build_academy_tenant.mjs` materializes this write-once path and records its SHA256.
The root bundle copy exists only for compatibility with existing local build
preflight; do not overwrite the old public root bundle on an existing preview.

Before activating the new HTML on an existing URL, seed the old versioned bundle
from the verified old root bundle. Preserve both immutable versions and the old
root alias. Upload and verify the new versioned JS before replacing manifest and
HTML; replace each mutable file atomically, HTML last, with no-store caching.
Two HTTP requests can cross a release switch, so a directory swap alone is not
a generation guarantee. A reused version path with different bytes must stop the
release. Existing old HTML keeps using the old root alias until page refresh.

Rollback restores the saved HTML and manifest first, retaining all bundle
versions and the old root alias, then disables only the owned backend tab if
appropriate. Keep consent evidence and foreign flow changes. Do not create real
purchases or bookings merely to validate publication.

The preview uses real Viva data and purchase endpoints. The transfer guide lists
prototype UI features and native push delivery prerequisites. Actual login,
provider purchase, Mongo writes and push delivery require separate acceptance
evidence. Publishing a prepared tenant cutover needs explicit target approval.

## Rodina visual identity

The academy uses navy `#000e18` / `#001522`, cyan `#00b9ed` and white from
https://cg178013.tw1.ru/. Original SVG marks in `src/academy/assets/` are bundled
locally. The theme is scoped to `.academy-shell`; shared sign-in receives the
academy presentation through the existing branding props.

# Subscription storefront: Figma and variant check, 2026-09-09

Local implementation on `codex/subscription-skins-tilda-20260909`, base `eb63bf537609a0dbf683134ac85e3d1d28b3ed58`.
No merge, push, deploy, Tilda mutation or provider/payment mutation in this change.

## Reference and acceptance limit

- User reference: https://www.figma.com/design/Oq4zP6seJcuAP3u4YXL7W9?node-id=1752-2761
- Native Figma viewer confirms parent desktop 1752:2759 is 1920 x 1080; child 1752:2761 is 1904 x 1064 with padding/gap 32.
- Full-resolution user PNG received: 3840 x 2160, transparent background. It was composited against the specified #FAFAFA for analysis; no black page background was introduced.
- PNG comparison completed against a 1920 x1080 browser at deviceScaleFactor2 with the same copy, two tabs and display prices. Card bounds480x648, content1496, inner width415, CTA415x51 and line wrapping were checked.
- The comparison is not byte-identical: font rasterization, subpixel metrics and shadows retain small differences. No claim of a zero-difference pixel match or updated Tilda publication is made.
- Interactive local comparison: http://127.0.0.1:5193/tmp/subscription-figma-check/index.html . Reference-mode fixture: `/docs/subscription-storefront-preview.html?reference=figma`.
- Deliberate working-page differences: three Friendship variants instead of two; real copy, periods, prices and availability instead of placeholder values. The third tab moves the pill below the price; on narrow containers its label wraps. The future two-hour variant stays disabled.

## Changes

- `src/components/subscription-storefront/catalog.ts`: monthly / future monthly-two-hours / annual identity, prices, availability and allowlisted checkout URLs. Future option is 1,980,000 minor units, disabled and has no checkout target. Annual always comes from explicit `network_friendship` status; aggregate cannot enable it.
- `SubscriptionPage.tsx`: explicit annual read with the existing loader and cancellation deadline; per-variant benefits and navigation guard. No product creation.
- `model.ts`, `SubscriptionPlanCard.tsx`, `SubscriptionOfferSection.tsx`: nullable price, per-option CTA/message/benefits, stable DOM wrapper to preserve radio focus through progress changes.
- `presentation.ts`: future two-hour copy; annual copy follows existing HAB annual card, excludes an unconfirmed tournament discount and includes the four-booking/two-week limit.
- `subscriptions.css`: centered content, Figma geometry/weights, 32px outer-card radii and 24px progress-panel radius, tabs, container-aware mobile layout.
- `assets/fonts/InterDisplay-{Regular,Medium,Bold}.woff2`, `assets/fonts/Inter-LICENSE.txt`: scoped local fonts. Regular/Medium are exact assets from colleague PR173. Bold is the official Inter 4.1 asset: https://rsms.me/inter/font-files/InterDisplay-Bold.woff2?v=4.1 ; declaration https://rsms.me/inter/inter.css . SHA256 `23bc37619593377e128f24660fedb2869d18277b4026cb46e5637be7643faf91`.
- `.github/workflows/lk1-subscription-enforcement.yml`, `scripts/tests/lk1SubscriptionEnforcementWorkflow.test.mjs`: exact file/hash binary exceptions for the three fonts.
- `scripts/tests/subscriptionStorefront.test.ts`: independent variant inventory, disabled future option, annual routing, missing/invalid price, stale data and wrong explicit counter regression.
- `docs/subscription-storefront-preview.html`: same three variants and copy, disabled demonstration checkout, cache-busted local bundle.

## Evidence

- `npm run lint`: passed, existing repository warnings.
- `tsc --noEmit -p tsconfig.app.json`: passed; scoped ESLint and `git diff --check`: passed after component fixes.
- Storefront + existing status-loader + workflow tests: 25 passed.
- `npm run build:subscription-storefront` and `build:subscription-storefront:dev`: passed.
- Full unrelated bundle build remains unverified locally because the existing worktree lacks the ignored build environment; full delivery baseline has the previously recorded Node22 DEV-readback cancellation. Neither is represented as PASS for this change.
- Clean Playwright browser: 16 assertions passed, 4 mocked GET status calls, zero purchase requests. Desktop 1920x1080, mobile375x812 and a375px embedded block in a1920px viewport.
- Desktop panels: x=212/720/1228, y=328, width480, height648; radii32/24/32. Content1496 wide.
- Actual browser fonts: heading `RFDewi-Bold`, subtitle `RFDewi-Semibold`, switch and suffix `InterDisplay-Medium`, discount badges `InterDisplay-Bold`; all custom fonts.
- Browser checks cover 19,800/Скоро, annual text, no mobile overflow, fitting radio labels, narrow embed progress widths, preserved focus with a single progress-bearing Friendship card, explicit false vs aggregate true, wrong explicit key with aggregate annual fallback.
- Screenshots and run output: `/private/tmp/subscription-variants-evidence-20260909/` (local artifacts outside Git). Test fixture harness: `/private/tmp/subscription-browser-check.js`.
- Read-only specialist reviews found three P2 defects (annual fallback, narrow-container width, focus loss); all three corrected and covered by unit/browser checks.

## Remaining boundaries

- Existing LK1 `variant=network_friendship` checkout has older terms than its default annual HAB card. Shared checkout/backend code was not changed here. Real purchase is untested and future product uncreated.
- Published page still serves the previous approved release. The new local assets require normal user verification, integration, push and deployment stages.

MODEL_ROUTE: parent

## PNG follow-up after fd61cb8

- Changed `subscriptions.css`: cap-height price trimming, 132% multiline leading, Figma list gaps and357px discount text width, half-pixel inner outlines without layout rounding, macOS antialiasing, exact desktop mark bounds and51px CTA height.
- Changed `SubscriptionStorefront.tsx`: default More menu matching the reference icon; existing local cabinet/home links and Escape focus restoration.
- Changed `presentation.ts`: brand spelling ПадлхАБ.
- Changed preview HTML: local-only Figma comparison data. Visually active reference CTAs still perform no action because preview `onChoose` returns immediately; public entrypoint rejects preview data outside local hostnames.
- Current checks: scoped ESLint, TypeScript, 8 storefront tests, prod/dev standalone builds, 18 browser assertions including More keyboard behavior and the previous variant/containment guards. Read-only UI review found no actionable issues.
- Comparison artifacts are in ignored `tmp/subscription-figma-check/`; PNGs are excluded from the checkpoint. RGB crop metrics and browser geometry are preserved there, not used as a readiness percentage.
- No full unrelated-bundle rebuild or payment tests were added for these UI-only follow-up changes. Prior limitations above still apply.

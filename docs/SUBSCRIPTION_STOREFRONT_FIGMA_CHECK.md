# Subscription storefront: Figma and variant check, 2026-09-09

Local implementation on `codex/subscription-skins-tilda-20260909`, base `eb63bf537609a0dbf683134ac85e3d1d28b3ed58`.
No merge, push, deploy, Tilda mutation or provider/payment mutation in this change.

## Reference and acceptance limit

- User reference: https://www.figma.com/design/Oq4zP6seJcuAP3u4YXL7W9?node-id=1752-2761
- Native Figma viewer confirms parent desktop 1752:2759 is 1920 x 1080; child 1752:2761 is 1904 x 1064 with padding/gap 32.
- Layout specifications came from the user-supplied Figma CSS. A native app screenshot of the desktop was inspected, but full-resolution PNG export could not be completed: the native UI alternated between unavailable windows and stale save-dialog state. Figma MCP also refused design/screenshot access for its connected identity.
- Full pixel comparison is **NOT VERIFIED**. It needs the exported desktop PNG. This is not a claim that the current Tilda publication matches the new local build.
- Deliberate differences: three Friendship variants instead of two; real product copy and availability instead of placeholder copy/figma counts; future two-hour option; no default action for the unassigned top-right More button. The third variant moves the pill below the price. Narrow containers wrap the middle label to keep all options reachable.

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

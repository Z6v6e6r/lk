import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function readFile(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("user profile renders referral CTAs in a dedicated block below the header", () => {
  const source = readFile("src/components/cabinet/UserProfile.tsx");

  assert.match(
    source,
    /<\/div>\s*\{\(shareOffer \|\| renewalOffer\) && \(\s*<div className="cab-header-referral-block">[\s\S]*\{shareOffer && \(\s*<div className="cab-header-referral-row">\s*<button\s+type="button"\s+className="cab-referral-inline-btn cab-referral-inline-btn--share"/s,
  );
  assert.match(source, /aria-label=\{`Поделиться подпиской \$\{shareOffer\.subscriptionName\}`\}/);
  assert.doesNotMatch(source, /className="cab-referral-inline-copy"/);
});

test("user profile keeps renewal CTA as a standalone button inside the dedicated referral block", () => {
  const source = readFile("src/components/cabinet/UserProfile.tsx");

  assert.match(
    source,
    /\{renewalOffer && \(\s*<div className="cab-header-referral-row">\s*<button\s+type="button"\s+className="cab-referral-copy-btn cab-referral-copy-btn--renewal"/s,
  );
  assert.match(source, /aria-label=\{`Продлить подписку \$\{renewalOffer\.subscriptionName\}`\}/);
  assert.match(source, /className="cab-referral-copy-btn-timer"/);
  assert.doesNotMatch(source, /className="cab-referral-card"/);
});

test("user profile keeps deposit below the name row with wallet icon before the amount", () => {
  const source = readFile("src/components/cabinet/UserProfile.tsx");

  assert.match(source, /className="cab-avatar-column"/);
  assert.match(source, /className="cab-avatar-tools"/);
  assert.match(source, /className="cab-user-topline"/);
  assert.match(source, /className="cab-user-balance-row"/);
  assert.match(source, /className="balance-inline balance-inline--header"/);
  assert.match(source, /className="balance-inline-icon"/);
  assert.match(source, /className="balance-inline-content"/);
  assert.match(source, /<svg width="10" height="10" viewBox="0 0 10 10"/);
  assert.doesNotMatch(source, />Депозит</);
  assert.match(source, /className="balance-amount balance-amount--compact"/);
});

test("share CTA preserves copy success and error feedback in header", () => {
  const source = readFile("src/components/cabinet/UserProfile.tsx");

  assert.match(source, /\{copyState === "done" \? "Скопировано" : "Поделиться с другом"\}/);
  assert.match(source, /className="cab-referral-inline-error"/);
  assert.match(source, /Не удалось скопировать ссылку\./);
});

test("header styles keep deposit under the name and referral CTAs in a vertical block", () => {
  const source = readFile("src/MyApp.css");

  assert.match(source, /\.cab-user-topline\s*\{/);
  assert.doesNotMatch(source, /\.cab-level-help/);
  assert.match(source, /\.cab-user-balance-row\s*\{[\s\S]*margin-top:\s*8px;/);
  assert.match(source, /\.cab-header-referral-block\s*\{[\s\S]*flex-direction:\s*column;[\s\S]*gap:\s*10px;/);
  assert.match(source, /\.cab-referral-inline-btn\s*\{[\s\S]*display:\s*inline-flex;[\s\S]*justify-content:\s*center;[\s\S]*white-space:\s*normal;/);
  assert.match(source, /\.cab-referral-inline-btn--share\s*\{[\s\S]*background:\s*#ffffff;/);
  assert.match(source, /\.cab-referral-inline-btn\s*\{[\s\S]*background:\s*var\(--purple\);/);
  assert.match(source, /\.cab-referral-inline-btn\s*\{[\s\S]*font-family:\s*var\(--btn-font\);/);
  assert.match(source, /\.cab-referral-copy-btn--renewal\s*\{[\s\S]*flex-wrap:\s*nowrap;[\s\S]*background:\s*var\(--subscription-bubble-fill\);[\s\S]*color:\s*#1a1a1a;/);
  assert.match(source, /\.cab-referral-copy-btn\s*\{[\s\S]*background:\s*var\(--purple\);/);
  assert.match(source, /\.cab-referral-copy-btn-timer\s*\{[\s\S]*flex:\s*0 0 auto;[\s\S]*font-family:\s*var\(--btn-font\);[\s\S]*color:\s*#1a1a1a;[\s\S]*white-space:\s*nowrap;/);
  assert.match(source, /\.balance-inline\.balance-inline--header\s*\{[\s\S]*background:\s*transparent;/);
  assert.match(source, /\.balance-inline\.balance-inline--header\s*\{[\s\S]*border:\s*1px dashed rgba\(26, 26, 26, 0\.24\);/);
  assert.match(source, /\.balance-inline\.balance-inline--header \.balance-inline-icon\s*\{/);
  assert.match(source, /\.balance-inline\.balance-inline--header \.balance-inline-icon\s*\{[\s\S]*width:\s*10px;[\s\S]*height:\s*10px;[\s\S]*color:\s*#1a1a1a;/);
  assert.match(source, /\.balance-inline\.balance-inline--header \.balance-inline-content\s*\{[\s\S]*flex-direction:\s*row;/);
  assert.match(source, /\.balance-inline\.balance-inline--header \.balance-amount--compact\s*\{[\s\S]*color:\s*#1a1a1a;/);
  assert.doesNotMatch(source, /\.balance-inline-label\s*\{/);
  assert.doesNotMatch(source, /\.cab-header-cta-grid\s*\{/);
  assert.match(source, /@media \(max-width: 560px\) \{[\s\S]*\.cab-referral-inline-btn,\s*\.cab-referral-copy-btn,\s*\.cab-referral-copy-btn-timer\s*\{\s*font-size:\s*11px;/);
  assert.doesNotMatch(source, /@media \(max-width: 390px\) \{[\s\S]*\.cab-header-cta-grid/);
});

test("user profile does not render the avatar level question mark helper", () => {
  const source = readFile("src/components/cabinet/UserProfile.tsx");

  assert.doesNotMatch(source, /cab-level-help/);
  assert.doesNotMatch(source, /Показать подсказку по уровню/);
  assert.doesNotMatch(source, /cab-level-help-dot/);
});

test("cabinet enables referral header CTAs on both prod and dev cabinet routes", () => {
  const source = readFile("src/components/cabinet/Cabinet.tsx");

  assert.match(source, /const shouldShowReferralHeaderCtas = useMemo\(\(\) => \{/);
  assert.match(
    source,
    /pathname\.includes\("\/lk_dev"\)[\s\S]*pathname === "\/lk"[\s\S]*pathname\.startsWith\("\/lk\/"\)[\s\S]*pathname === "\/lk_new"[\s\S]*pathname\.startsWith\("\/lk_new\/"\)/,
  );
  assert.match(source, /shouldShowReferralHeaderCtas\s*\?\s*resolveReferralShareOwnerCandidate/);
  assert.match(source, /shouldShowReferralHeaderCtas\s*\?\s*resolveReferralRenewalOwnerCandidate/);
  assert.match(source, /if \(!shouldShowReferralHeaderCtas\) return null;/);
});

test("cabinet uses finished-aware subscriptions for referral renewal candidates", () => {
  const cabinetSource = readFile("src/components/cabinet/Cabinet.tsx");
  const apiSource = readFile("src/utils/apiClient.ts");

  assert.match(apiSource, /export interface SubscriptionFetchOptions\s*\{[\s\S]*includeFinished\?: boolean;/);
  assert.match(apiSource, /if \(options\.includeFinished\) query\.set\("includeFinished", "true"\);/);
  assert.match(cabinetSource, /const REFERRAL_SUBSCRIPTIONS_FETCH_OPTIONS = \{\s*includeFinished: true,\s*size: 100,\s*\};/);
  assert.match(cabinetSource, /apiFetchSubscriptions\(REFERRAL_SUBSCRIPTIONS_FETCH_OPTIONS\)/);
  assert.match(cabinetSource, /setReferralUserSubscriptions\(referralSubsRes\?\.data \|\| subsRes\?\.data \|\| null\);/);
  assert.match(cabinetSource, /const referralSubscriptionSource = useMemo\(\(\) => \{/);
  assert.match(cabinetSource, /hydrateReferralSubscriptionsWithNames\(referralSubscriptionSource, referralSubscriptionNamesById\)/);
});

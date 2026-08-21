import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const groupSchedulePageSource = fs.readFileSync("src/components/group-schedule/GroupSchedulePage.tsx", "utf8");
const groupScheduleCssSource = fs.readFileSync("src/components/group-schedule/GroupSchedulePage.css", "utf8");
const communityTournamentCardSource = fs.readFileSync("src/components/cabinet/community-feed/CommunityTournamentCard.tsx", "utf8");
const communityTournamentCardCssSource = fs.readFileSync("src/components/cabinet/community-feed/CommunityTournamentCard.module.css", "utf8");
const appCssSource = fs.readFileSync("src/MyApp.css", "utf8");

test("group schedule detail uses unified signup card and multiselect type filter", () => {
  assert.match(groupSchedulePageSource, /isGamePlusTrainerSummary/);
  assert.match(groupSchedulePageSource, /TYPE_FILTER_ALL_LABEL = "Все типы"/);
  assert.match(groupSchedulePageSource, /getTrainingTypeFilterLabel/);
  assert.match(groupSchedulePageSource, /formatSelectedTypeFilterLabel/);
  assert.match(groupSchedulePageSource, /const \[selectedTypeFilters, setSelectedTypeFilters\] = useState<string\[\]>\(\[\]\);/);
  assert.match(groupSchedulePageSource, /const \[typeFilterOptions, setTypeFilterOptions\] = useState<string\[\]>\(\[\]\);/);
  assert.match(groupSchedulePageSource, /const \[isTypeFilterOpen, setTypeFilterOpen\] = useState\(false\);/);
  assert.match(groupSchedulePageSource, /const typeFilterRef = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(groupSchedulePageSource, /items\.map\(getTrainingTypeFilterLabel\)/);
  assert.match(groupSchedulePageSource, /setTypeFilterOptions\(\(previous\) => uniqueSorted\(\[\.\.\.previous, \.\.\.nextOptions\]\)\);/);
  assert.match(groupSchedulePageSource, /aria-multiselectable="true"/);
  assert.match(groupSchedulePageSource, /group-schedule-type-filter-menu/);
  assert.match(groupSchedulePageSource, /selectedTypeFilterSet\.has\(typeLabel\)/);
  assert.match(groupSchedulePageSource, /setSelectedTypeFilters\(\(previous\) => \(/);
  assert.match(groupSchedulePageSource, /uniqueSorted\(\[\.\.\.previous, value\]\)/);
  assert.match(groupSchedulePageSource, /GROUP_SCHEDULE_SUBSCRIPTION_URL = "https:\/\/padlhub\.ru\/ab_leto"/);
  assert.match(groupSchedulePageSource, /group-schedule-detail--trainer/);
  assert.match(groupSchedulePageSource, /group-schedule-details-card--trainer/);
  assert.match(groupSchedulePageSource, /group-schedule-trainer-info-card/);
  assert.match(groupSchedulePageSource, /group-schedule-trainer-info-row--person/);
  assert.match(groupSchedulePageSource, /group-schedule-registration--trainer/);
  assert.match(groupSchedulePageSource, /getNameInitials/);
  assert.match(groupSchedulePageSource, /formatTrainerDateTimeLabel/);
  assert.match(groupSchedulePageSource, /formatTrainerStationCourtLabel/);
  assert.match(groupSchedulePageSource, /buildGroupTrainingDescription/);
  assert.match(groupSchedulePageSource, /getTrainingDetailEyebrow/);
  assert.match(groupSchedulePageSource, /getTrainingDetailTitleLines/);
  assert.match(groupSchedulePageSource, /const detailDescription = selectedTraining/);
  assert.match(groupSchedulePageSource, /returnToFindGame\?: boolean/);
  assert.match(groupSchedulePageSource, /const shouldExitInitialDetail = Boolean\(returnToFindGame && initialExerciseId && selectedId === initialExerciseId\);/);
  assert.match(groupSchedulePageSource, /if \(shouldExitInitialDetail\) \{\s*onBack\(\);/);
  assert.match(groupSchedulePageSource, /GAME_PLUS_TRAINER_DEFAULT_DESCRIPTION/);
  assert.match(groupSchedulePageSource, /tournament-signup-payment-subscription-link/);
  assert.match(groupSchedulePageSource, /Доступные варианты/);
  assert.match(groupSchedulePageSource, /Приобрести подписку РА \/ Академия/);
  assert.match(groupSchedulePageSource, /function formatProductUsageLabel\(product: TournamentVivaProduct\)/);
  assert.match(groupSchedulePageSource, /resolveSubscriptionUsageDisplay\(\{/);
  assert.match(groupSchedulePageSource, /validityPrefix: "действует до"/);
  assert.match(groupSchedulePageSource, /function formatProductValidity\(product: TournamentVivaProduct\)/);
  assert.match(groupSchedulePageSource, /product\.source !== "client-subscription"/);
  assert.match(groupSchedulePageSource, /formatProductUsageLabel\(product\) \|\| "срок уточняется"/);
  assert.match(groupSchedulePageSource, /if \(product\.source === "one-time" \|\| product\.source === "client-one-time"\) return "";/);
  assert.match(groupSchedulePageSource, /const stationLabel = training\.studioName \|\| "Станция уточняется";/);
  assert.match(groupSchedulePageSource, /variant="groupSchedule"/);
  assert.doesNotMatch(groupSchedulePageSource, /CalendarClockIcon/);
  assert.doesNotMatch(groupSchedulePageSource, /ClockIcon/);
  assert.doesNotMatch(groupSchedulePageSource, /formatCancellationValue/);
  assert.doesNotMatch(groupSchedulePageSource, /formatDeadline/);
  assert.doesNotMatch(groupSchedulePageSource, /return " \/ 1 посещение"/);
  assert.doesNotMatch(groupSchedulePageSource, /const stationLabel = \[training\.studioName, training\.roomName\]\.filter\(Boolean\)\.join\(" • "\);/);
  assert.doesNotMatch(groupSchedulePageSource, /group-schedule-trainer-fact/);
  assert.doesNotMatch(groupSchedulePageSource, /setTypeFilter\(ALL_FILTER_VALUE\)/);
  assert.doesNotMatch(groupSchedulePageSource, /type="search"/);
  assert.doesNotMatch(groupSchedulePageSource, /datalist/);
  assert.doesNotMatch(groupSchedulePageSource, /normalizeFilterText/);
  assert.doesNotMatch(groupSchedulePageSource, /className="tournament-signup-facts group-schedule-facts"/);
  assert.doesNotMatch(groupSchedulePageSource, /className="group-schedule-detail-head"/);
  assert.doesNotMatch(groupSchedulePageSource, /className="group-schedule-trainer-info-label">Время/);
  assert.doesNotMatch(groupSchedulePageSource, /className="group-schedule-trainer-info-label">Корт/);
  assert.doesNotMatch(groupSchedulePageSource, /className="group-schedule-trainer-info-label">Места/);
  assert.doesNotMatch(groupSchedulePageSource, /className="group-schedule-trainer-info-label">Отмена/);

  assert.match(groupScheduleCssSource, /\.group-schedule-details-card--trainer/);
  assert.match(groupScheduleCssSource, /\.group-schedule-type-filter-menu/);
  assert.match(groupScheduleCssSource, /\.group-schedule-type-filter-option/);
  assert.match(groupScheduleCssSource, /\.group-schedule-type-filter-check/);
  assert.match(groupScheduleCssSource, /\.group-schedule-type-filter-trigger/);
  assert.match(groupScheduleCssSource, /justify-content: space-between;/);
  assert.match(groupScheduleCssSource, /appearance: none;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-detail--trainer/);
  assert.match(groupScheduleCssSource, /\.group-schedule-trainer-info-card/);
  assert.match(groupScheduleCssSource, /\.group-schedule-trainer-info-row/);
  assert.match(groupScheduleCssSource, /\.group-schedule-registration--trainer/);
  assert.match(groupScheduleCssSource, /grid-template-columns: 32px minmax\(68px, 0\.75fr\) minmax\(0, 1\.25fr\)/);
  assert.match(groupScheduleCssSource, /grid-template-columns: 40px minmax\(0, 1fr\) 20px/);
  assert.match(groupScheduleCssSource, /height: 56px/);
  assert.match(groupScheduleCssSource, /\.group-schedule-trainer-description/);
  assert.ok(groupScheduleCssSource.includes(".group-schedule-registration {\n  border-radius: 16px;\n  grid-template-columns: 1fr;"));
  assert.ok(groupScheduleCssSource.includes(".group-schedule-registration > div + div {\n  border-left: 0;\n  border-top: 0;"));
  assert.ok(groupScheduleCssSource.includes(".group-schedule-registration .auth-wrapper {\n  min-height: 0;\n  padding: 0;\n  background: transparent;"));
  assert.ok(groupScheduleCssSource.includes(".group-schedule-registration .auth-card {\n  max-width: none;"));
  assert.doesNotMatch(groupScheduleCssSource, /group-schedule-trainer-fact/);
  assert.doesNotMatch(groupScheduleCssSource, /(?!#9ca3af)#[0-9a-fA-F]{3,8}|rgba\(/);
  assert.doesNotMatch(groupScheduleCssSource, /font-size: 4[0-9]px|min-height: 8[0-9]px|width: 82px|height: 82px|radial-gradient/);
});

test("group schedule list cards hide redundant training badge and level metadata", () => {
  assert.match(communityTournamentCardSource, /variant\?: "default" \| "groupSchedule"/);
  assert.match(communityTournamentCardSource, /variant = "default"/);
  assert.match(communityTournamentCardSource, /const isGroupScheduleVariant = variant === "groupSchedule";/);
  assert.match(
    communityTournamentCardSource,
    /!\s*isGroupScheduleVariant && \(\s*<span className=\{`\$\{styles\.badge\}/,
  );
  assert.match(
    communityTournamentCardSource,
    /!\s*isGroupScheduleVariant && \(\s*<span className=\{styles\.metaRow\}>[\s\S]*?<LevelMetaIcon \/>/,
  );
  assert.match(
    communityTournamentCardSource,
    /!\s*isGroupScheduleVariant && \(\s*<div className=\{styles\.capacityRemaining\}>/,
  );
  assert.match(communityTournamentCardSource, /const waitlistCount = Math\.max\(0, card\.waitlistCount \?\? 0\);/);
  assert.match(communityTournamentCardSource, /const shouldShowWaitlist = !isGroupScheduleVariant \|\| waitlistCount > 0;/);
  assert.match(communityTournamentCardSource, /\{shouldShowWaitlist \? \(/);
  assert.match(communityTournamentCardSource, /Лист ожидания: \{waitlistCount\}/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.title/);
  assert.match(communityTournamentCardCssSource, /font-weight: 700;/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.meta/);
  assert.match(communityTournamentCardCssSource, /font-family: "Inter Display", Inter, "SF Pro Text"/);
  assert.match(communityTournamentCardCssSource, /letter-spacing: 0\.02em;/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.metaRow/);
  assert.match(communityTournamentCardCssSource, /padding-right: 88px/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.capacityLabels/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.priceWrap/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.price/);
  assert.match(communityTournamentCardCssSource, /margin-top: -38px/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.footer/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.waitlist/);
  assert.match(communityTournamentCardCssSource, /\.tournamentGroupSchedule \.action/);
  assert.match(communityTournamentCardCssSource, /justify-self: end;/);
  assert.match(appCssSource, /font-family: 'Inter Display';[\s\S]*?url\('\.\/fonts\/InterDisplay-Regular\.woff2'\) format\('woff2'\);/);
  assert.match(appCssSource, /font-family: 'Inter Display';[\s\S]*?url\('\.\/fonts\/InterDisplay-Medium\.woff2'\) format\('woff2'\);/);
  assert.doesNotMatch(communityTournamentCardCssSource, /"Inter Display", "RF Dewi"/);
});

test("group schedule promo uses provider preview and applies the quote only to its product", () => {
  assert.doesNotMatch(groupSchedulePageSource, /const GROUP_SCHEDULE_PROMO_VISIBLE = false;/);
  assert.match(groupSchedulePageSource, /const shouldShowGroupSchedulePromoSection = Boolean\(checkout && checkout\.oneTimes\.some\(isGroupSchedulePromoProduct\)\)/);
  assert.match(
    groupSchedulePageSource,
    /const GROUP_SCHEDULE_PROMO_TRIGGER_TEXT = "у меня есть промокод";/,
  );
  assert.match(groupSchedulePageSource, /const \[isGroupSchedulePromoExpanded, setGroupSchedulePromoExpanded\] = useState\(false\);/);
  assert.match(groupSchedulePageSource, /const groupSchedulePromoSectionId = useId\(\);/);
  assert.match(groupSchedulePageSource, /placeholder="Введите промокод"/);
  assert.doesNotMatch(groupSchedulePageSource, /placeholder="Например, PIK-PADELHUB"/);
  assert.match(groupSchedulePageSource, /setGroupSchedulePromoExpanded\(false\);/);
  assert.match(groupSchedulePageSource, /aria-expanded={isGroupSchedulePromoExpanded}/);
  assert.match(groupSchedulePageSource, /aria-controls={groupSchedulePromoSectionId}/);
  assert.match(groupSchedulePageSource, /id={groupSchedulePromoSectionId}/);
  assert.match(groupSchedulePageSource, /hidden={!isGroupSchedulePromoExpanded}/);
  assert.match(groupSchedulePageSource, /setGroupSchedulePromoExpanded\(\(current\) => !current\)/);
  assert.match(groupSchedulePageSource, /shouldShowGroupSchedulePromoSection && \(/);
  assert.match(groupSchedulePageSource, /className="group-schedule-promo-trigger"/);
  assert.match(groupSchedulePageSource, /GROUP_SCHEDULE_PROMO_TRIGGER_TEXT/);
  assert.match(groupSchedulePageSource, /className="group-schedule-promo-section"/);
  assert.match(groupSchedulePageSource, /aria-hidden={!isGroupSchedulePromoExpanded}/);
  assert.match(groupSchedulePageSource, /apiPreviewTournamentVivaTransaction/);
  assert.match(groupSchedulePageSource, /normalizeGroupSchedulePromoCode/);
  assert.match(groupSchedulePageSource, /isGroupSchedulePromoPreviewApplicable/);
  assert.match(groupSchedulePageSource, /getAppliedGroupSchedulePromoPreview/);
  assert.match(groupSchedulePageSource, /activeCheckout\.oneTimes\.filter\(isGroupSchedulePromoProduct\)/);
  assert.match(groupSchedulePageSource, /checkout\.oneTimes\.some\(isGroupSchedulePromoProduct\)/);
  assert.match(groupSchedulePageSource, /promoCode: code/);
  assert.match(groupSchedulePageSource, /promoRequestIdRef\.current !== requestId/);
  assert.match(groupSchedulePageSource, /promoPreview \? appliedPromo\?\.code : null/);
  assert.match(groupSchedulePageSource, /Промокод применён\. Viva подтвердила специальную цену\./);
  assert.match(groupSchedulePageSource, /formatMoneyMinor\(promoPreview\.toPayMinor\)/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?position: relative;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?z-index: 1;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?width: 100%;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?min-height: 44px;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?border: none;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?background: transparent;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?padding: 8px 12px 12px;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?font-size: 12px;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?line-height: 1\.4;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?color: #9ca3af;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?text-align: center;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?cursor: pointer;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?pointer-events: auto;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-trigger[\s\S]*?touch-action: manipulation;/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-controls/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-input/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-price-old/);
  assert.match(groupScheduleCssSource, /\.group-schedule-promo-price > span[\s\S]*?white-space: nowrap/);
});

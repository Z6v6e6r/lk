import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const findGamePageSource = fs.readFileSync("src/components/games/FindGamePage.tsx", "utf8");
const gamesEntrySource = fs.readFileSync("src/games.tsx", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const myAppSource = fs.readFileSync("src/MyApp.tsx", "utf8");
const myAppCssSource = fs.readFileSync("src/MyApp.css", "utf8");

test("find game create link forces dev channel when returning to lk_dev", () => {
  assert.match(findGamePageSource, /function isDevCabinetUrl/);
  assert.match(findGamePageSource, /if \(isDevCabinetUrl\(resolvedCabinetUrl\)\) \{\s*url\.searchParams\.set\("channel", "dev"\);/);
});

test("find game keeps leave-state split games visible when they are still joinable", () => {
  assert.match(findGamePageSource, /if \(viewerState !== "none"\) return true;/);
  assert.match(findGamePageSource, /return participantCount < maxPlayers \|\| resolveWaitlistEnabled\(game\);/);
  assert.doesNotMatch(findGamePageSource, /hasInactiveSplitPaymentForViewer/);
  assert.doesNotMatch(findGamePageSource, /hasLeaveEventForViewer/);
  assert.doesNotMatch(findGamePageSource, /hasPublicRosterData\(game\)/);
});

test("find game plus trainer cards are opt-in and avoid per-card request fan-out", () => {
  assert.match(findGamePageSource, /includeGamePlusTrainer\?: boolean/);
  assert.match(findGamePageSource, /const shouldIncludeGamePlusTrainer = includeGamePlusTrainer === true;/);
  assert.doesNotMatch(findGamePageSource, /IS_DEV_RELEASE_CHANNEL && includeGamePlusTrainer/);
  assert.match(gamesEntrySource, /const includeGamePlusTrainer = isFindEntry && data\?\.includeGamePlusTrainer !== false;/);
  assert.match(gamesEntrySource, /includeGamePlusTrainer=\{includeGamePlusTrainer\}/);
  assert.match(myAppSource, /const includeGamePlusTrainer = includeGamePlusTrainerRaw\s*\?\s*\/\^\(1\|true\|yes\)\$\/i\.test\(includeGamePlusTrainerRaw\)\s*:\s*byPath;/);
  assert.match(findGamePageSource, /function buildFindGameReturnUrl/);
  assert.match(findGamePageSource, /const returnUrl = buildFindGameReturnUrl\(resolvedCabinetUrl\);/);
  assert.match(findGamePageSource, /url\.searchParams\.set\("cabinetUrl", returnUrl\);/);
  assert.match(findGamePageSource, /url\.searchParams\.set\("returnTo", "finde_game"\);/);
  assert.match(findGamePageSource, /isDevCabinetUrl\(resolvedCabinetUrl\) \|\| IS_DEV_RELEASE_CHANNEL/);
  assert.match(findGamePageSource, /apiFetchGroupTrainingsByDate\(selectedDateKey\)/);
  assert.match(findGamePageSource, /\.filter\(isGamePlusTrainerSummary\)/);
  assert.doesNotMatch(findGamePageSource, /apiFetchTournamentVivaPublicCheckout/);
  assert.doesNotMatch(findGamePageSource, /apiFetchTournamentParticipants/);
  assert.doesNotMatch(findGamePageSource, /normalizeTournamentSignupPublicRoster/);
  assert.match(findGamePageSource, /const participantCount = Math\.min\(training\.clientsCount, maxPlayers\);/);
  assert.match(findGamePageSource, /Array\.from\(\{ length: participantCount \}/);
  assert.match(findGamePageSource, /GAME_PLUS_TRAINER_DEFAULT_PRICE_VALUE_LABEL = "5500"/);
  assert.match(findGamePageSource, /GAME_PLUS_TRAINER_INCLUDED_PRICE_LABELS = \["Энергия5", "академия", "РА"\] as const/);
  assert.match(findGamePageSource, /\[priceValueLabel \|\| GAME_PLUS_TRAINER_DEFAULT_PRICE_VALUE_LABEL, \.\.\.GAME_PLUS_TRAINER_INCLUDED_PRICE_LABELS\]\.join\("\/"\)/);
  assert.match(findGamePageSource, /type FindGameKindFilter = "all" \| "game" \| "game-plus-trainer"/);
  assert.match(findGamePageSource, /const FIND_GAME_KIND_OPTIONS: Array<\{ value: FindGameKindFilter; label: string \}>/);
  assert.match(findGamePageSource, /const \[kindFilters, setKindFilters\] = useState<string\[]>\(\(\) => readAtlasMultiValues\(/);
  assert.match(findGamePageSource, /kindFilters\.length > 0 && !kindFilters\.includes\("game"\)/);
  assert.match(findGamePageSource, /kindFilters\.length > 0 && !kindFilters\.includes\("game-plus-trainer"\)/);
  assert.match(findGamePageSource, /setGamePlusTrainerTrainings\(trainings\);\s*setGamePlusTrainerLoading\(false\);/);
  assert.doesNotMatch(findGamePageSource, /setGamePlusTrainerMetaById/);
  assert.doesNotMatch(findGamePageSource, /trainings\.forEach\(\(training\) =>/);
  assert.match(findGamePageSource, /find-game-friendly-tag find-game-friendly-tag-gold/);
  assert.match(findGamePageSource, /className="find-game-friendly-tag"\s+aria-label="Тег игры"/);
  assert.doesNotMatch(findGamePageSource, /Ваш \{viewer\.level\}/);
  assert.doesNotMatch(findGamePageSource, /game-created-tag-duration/);
  assert.match(myAppCssSource, /\.find-game-friendly-tag \{[\s\S]*?display: inline-flex;[\s\S]*?padding: 0 10px;[\s\S]*?gap: 5px;[\s\S]*?width: auto;[\s\S]*?height: 22px;[\s\S]*?border-radius: 999px;/);
  assert.match(myAppCssSource, /\.find-game-friendly-tag-dot \{[\s\S]*?width: 13px;[\s\S]*?height: 13px;[\s\S]*?flex: 0 0 13px;/);
  assert.match(myAppCssSource, /\.find-game-friendly-tag-dot::before \{[\s\S]*?repeating-conic-gradient\(from 0deg, #4db369/);
  assert.match(myAppCssSource, /\.find-game-friendly-tag \.find-game-friendly-tag-text \{[\s\S]*?font-weight: 700;[\s\S]*?font-size: 11px;/);
  assert.match(myAppCssSource, /@media \(max-width: 390px\) \{[\s\S]*?\.find-game-friendly-tag,[\s\S]*?height: 20px;[\s\S]*?padding: 0 9px;[\s\S]*?\.find-game-friendly-tag-dot,[\s\S]*?width: 12px;[\s\S]*?font-size: 10\.5px;/);
  assert.doesNotMatch(myAppCssSource, /\.find-game-friendly-tag[\s\S]{0,220}transform:\s*scale\(/);
  assert.match(myAppCssSource, /\.find-game-training-price strong \{[\s\S]*?font-size: 11px;[\s\S]*?white-space: nowrap;/);
  assert.match(findGamePageSource, /\{priceLabel\}<\/strong>/);
  assert.doesNotMatch(findGamePageSource, /<span>Запись<\/span>/);
  assert.doesNotMatch(findGamePageSource, /Присоединиться за<\/span>\s*<strong>\{priceLabel\}<\/strong>/);
});

test("opening a group training upgrades the list summary with the full detail request", () => {
  const source = fs.readFileSync("src/components/group-schedule/GroupSchedulePage.tsx", "utf8");
  const detailEffectStart = source.indexOf("if (!selectedId) {");
  const detailEffectEnd = source.indexOf("const loadRegistrationState", detailEffectStart);
  const detailEffect = source.slice(detailEffectStart, detailEffectEnd);

  assert.match(detailEffect, /const fromList = items\.find/);
  assert.match(detailEffect, /setSelectedDetail\(fromList\)/);
  assert.doesNotMatch(detailEffect, /setSelectedDetail\(fromList\);[\s\S]{0,80}return;/);
  assert.match(detailEffect, /apiFetchGroupTrainingDetail\(selectedId\)/);
  assert.match(source, /apiFetchTournamentParticipants\(selectedId, \{[\s\S]*auth: false,[\s\S]*retries: 0,[\s\S]*signal: controller\.signal/);
  assert.match(source, /normalizeTournamentSignupPublicRoster\(result\.data\)/);
  assert.match(source, /aria-label="Состав игры"/);
});

test("public find game stays accessible without forcing auth first", () => {
  const standaloneFindIdx = gamesEntrySource.indexOf("if (isFindEntry)");
  const standaloneRestoreIdx = gamesEntrySource.indexOf("if (isRestoringSession)");
  const standaloneAuthIdx = gamesEntrySource.indexOf("if (!isAuthenticated)");

  assert.notEqual(standaloneFindIdx, -1);
  assert.notEqual(standaloneRestoreIdx, -1);
  assert.notEqual(standaloneAuthIdx, -1);
  assert.ok(standaloneFindIdx < standaloneRestoreIdx);
  assert.ok(standaloneFindIdx < standaloneAuthIdx);

  const myAppFindIdx = myAppSource.indexOf("if (findRouteData.enabled)");
  const myAppCommunityJoinIdx = myAppSource.indexOf("if (communityJoinRouteData.enabled)");
  assert.notEqual(myAppFindIdx, -1);
  assert.notEqual(myAppCommunityJoinIdx, -1);

  const myAppFindBlock = myAppSource.slice(myAppFindIdx, myAppCommunityJoinIdx);
  assert.doesNotMatch(myAppFindBlock, /if \(!isAuthenticated\)/);
  assert.match(myAppFindBlock, /publicFindEntry: true/);
  assert.match(myAppFindBlock, /includeGamePlusTrainer: findRouteData\.includeGamePlusTrainer/);
});

test("public game create flow uses dedicated summary and split checkout selection", () => {
  assert.match(gamesPageSource, /className="app-container game-container game-container-place-step"/);
  assert.match(gamesPageSource, /className="app-container game-container game-container-time-step"/);
  assert.match(gamesPageSource, /const usePublicCreateWizard = publicCreateEntry && !isBookingPresetMode;/);
  assert.match(gamesPageSource, /const PUBLIC_CREATE_SUBSCRIPTION_INFO_URL = "https:\/\/padlhub\.ru\/ab_leto";/);
  assert.match(gamesPageSource, /const resetSelectedTime = useCallback\(\(\) => \{/);
  assert.match(gamesPageSource, /const resetSelectedCourt = useCallback\(\(\) => \{/);
  assert.match(gamesPageSource, /const renderSelectedParamsChips = \(\) => \(/);
  assert.match(gamesPageSource, /const isContinueDisabled = \(\) => !\(hasCompleteTimeSelection && paymentMode\);/);
  assert.match(gamesPageSource, /const shouldShowPublicSplitSubscriptionInfoBadge = !splitHasSubscriptionPaymentOptions/);
  assert.match(gamesPageSource, /const shouldShowPublicationJoinPriceField = !usePublicCreateWizard;/);
  assert.match(gamesPageSource, /const publicCreateFullCourtDescription = "Вы оплачиваете весь корт сами\. После создания игру можно открыть для всех или оставить приватной\.";/);
  assert.match(gamesPageSource, /function resolvePublicCreateDefaultRatingRange\(/);
  assert.match(gamesPageSource, /const publicCreateRatingRangeTouchedRef = useRef\(false\);/);
  assert.match(gamesPageSource, /const publicCreateDefaultRatingRangeAppliedRef = useRef\(false\);/);
  assert.match(gamesPageSource, /const defaultRange = resolvePublicCreateDefaultRatingRange\(profileGrade, profileRatingNumeric\);/);
  assert.match(gamesPageSource, /applyPublicCreateCoarseRatingRange\(defaultRange\.minRating, defaultRange\.maxRating\);/);
  assert.match(gamesPageSource, /if \(!splitPaymentSelected && shouldShowPublicationJoinPriceField && !normalizedGameJoinPrice\) \{/);
  assert.match(gamesPageSource, /className="game-summary-edit-button"/);
  assert.match(gamesPageSource, /className="team-card game-create-level-card"/);
  assert.match(gamesPageSource, /duration-chip--friendship/);
  assert.match(gamesPageSource, /date-chip--friendship/);
  assert.match(gamesPageSource, /game-create-summary-card game-create-summary-card--review/);
  assert.match(gamesPageSource, /publicCreatePreciseRatingMetadata/);
  assert.match(gamesPageSource, /ratingRangePrecise: \{/);
  assert.match(gamesPageSource, /Уровень игры/);
  assert.match(gamesPageSource, /Уровень игроков/);
  assert.match(gamesPageSource, /publicCreateLevelSummaryLabel/);
  assert.match(gamesPageSource, /Результаты игры не влияют на уровень/);
  assert.match(gamesPageSource, /handlePublicCreateLevelButtonSelect/);
  assert.match(gamesPageSource, /className="game-create-level-compact-panel"/);
  assert.match(gamesPageSource, /game-create-level-range-strip/);
  assert.match(gamesPageSource, /if \(normalizedIndex === minRating\) \{\s*applyPublicCreateCoarseRatingRange\(minRating \+ 1, maxRating\);/);
  assert.match(gamesPageSource, /if \(normalizedIndex === maxRating\) \{\s*applyPublicCreateCoarseRatingRange\(minRating, maxRating - 1\);/);
  assert.match(gamesPageSource, /Название игры для публикации/);
  assert.match(gamesPageSource, /Минимальная буква уровня/);
  assert.match(gamesPageSource, /Максимальная цифра уровня/);
  assert.match(gamesPageSource, /renderPublicCreateSummaryIcon\("place"\)/);
  assert.match(gamesPageSource, /className="game-create-summary-meta-row"/);
  assert.match(gamesPageSource, /!usePublicCreateWizard && selectedCourt && \(/);
  assert.match(gamesPageSource, /!usePublicCreateWizard && time && \(/);
  assert.match(gamesPageSource, /!isBookingPresetMode && !usePublicCreateWizard && \(\s*<div className="team-card">\s*<div className="game-card-title">Команда<\/div>/);
  assert.match(gamesPageSource, /!usePublicCreateWizard && \(\s*<div className="game-section">\s*<div className="team-card game-selected-params-card">/);
  assert.match(gamesPageSource, /className="game-time-chip-reset"/);
  assert.match(gamesPageSource, /className="game-court-option-reset"/);
  assert.match(gamesPageSource, /const splitHasEligibleSubscriptions = splitSubscriptions\.length > 0;/);
  assert.doesNotMatch(gamesPageSource, /duration < 120/);
  assert.doesNotMatch(gamesPageSource, /splitSubscriptionsAllowedForDuration/);
  assert.doesNotMatch(
    gamesPageSource,
    /const resolvedPaymentMode = preferredPaymentMode === "subscription" && !canUseSplitSubscription[\s\S]*\? "one_time"/,
  );
  assert.match(
    gamesPageSource,
    /if \(preferredPaymentMode === "subscription" && !canUseSplitSubscription\) \{[\s\S]*Выбранный абонемент больше недоступен/,
  );
  assert.match(gamesPageSource, /shouldShowPublicSplitSubscriptionBadge \? \(\s*<span className="game-payment-choice-badge">Подписка<\/span>/);
  assert.match(gamesPageSource, /game-payment-choice-price\$\{shouldShowPublicSplitSubscriptionBadge \? " game-payment-choice-price--discounted" : ""\}/);
  assert.match(gamesPageSource, /!usePublicCreateWizard && <span className="game-submit-price">\{paymentBookingAmount\}<\/span>/);
  assert.match(gamesPageSource, /className=\{`game-payment-choice-card game-payment-choice-card--payer \$\{splitPaymentSelected \? "selected" : ""\}`\}/);
  assert.match(gamesPageSource, /publicCreateFinalSubmitTitle/);
  assert.match(gamesPageSource, /Параметры игры/);
  assert.match(gamesPageSource, /Показано время для/);
  assert.match(gamesPageSource, /Сбросить корт/);
  assert.match(gamesPageSource, /Показаны корты на/);
  assert.match(gamesPageSource, /Сбросить время/);
  assert.match(gamesPageSource, /Доступность игры/);
  assert.match(gamesPageSource, /className="game-create-visibility-options"/);
  assert.match(gamesPageSource, /className="game-visibility-option-title-row"/);
  assert.match(gamesPageSource, /game-visibility-option game-visibility-option--public/);
  assert.match(gamesPageSource, /game-visibility-option game-visibility-option--private/);
  assert.match(gamesPageSource, /Общий список игр/);
  assert.match(gamesPageSource, /game-autopublish-card--general-list/);
  assert.match(gamesPageSource, /game-autopublish-card--general-list game-autopublish-card--readonly/);
  assert.match(gamesPageSource, /game-autopublish-card-avatar--square/);
  assert.match(gamesPageSource, /defaultSelectedIds: usePublicCreateWizard && stationTarget\?\.id/);
  assert.match(gamesPageSource, /const next = usePublicCreateWizard\s*\?\s*defaults\s*:\s*\(preserved.length > 0 \? preserved : defaults\);/);
  assert.match(gamesPageSource, /allowStationWithoutMembership: usePublicCreateWizard/);
  assert.match(
    gamesPageSource,
    /if \(!ENABLE_GAME_COMMUNITY_AUTOPUBLISH \|\| !usePublicCreateWizard\) return;[\s\S]*const next = !isPrivate && communityAutopublishStationTarget\?\.id[\s\S]*:\s*\[];/,
  );
  assert.match(gamesPageSource, /!usePublicCreateWizard && \(\s*<div className="game-publish-fields-note">/);
  assert.match(gamesPageSource, /Быстрее собрать/);
  assert.match(gamesPageSource, /Для своих/);
  assert.match(gamesPageSource, /Приватная игра/);
  assert.match(gamesPageSource, /Способ оплаты записи/);
  assert.match(gamesPageSource, /game-payment-choice-card game-payment-choice-card--subscription/);
  assert.match(gamesPageSource, /Создать игру по подписке/);
  assert.match(gamesPageSource, /Создать игру с помощью подписки/);
  assert.match(gamesPageSource, /splitPaymentAvailable && splitPaymentSelected && !usePublicCreateWizard && \(/);
  assert.match(gamesPageSource, /shouldShowPublicationJoinPriceField && \(\s*<label className="game-publish-field">\s*<span className="game-publish-field-label">Стоимость присоединения к игре<\/span>/);
  assert.match(gamesPageSource, /const publicCreateJoinersPillLabel = createInviteSlotsCount > 0/);
  assert.match(gamesPageSource, /Каждый платит за себя/);
  assert.match(gamesPageSource, /Соберу игроков сам/);
  assert.match(gamesPageSource, /setPaymentMode\("self"\);\s*setIsPrivate\(false\);/);
  assert.match(gamesPageSource, /Подписка/);
  assert.match(gamesPageSource, /Узнать подробнее/);
  assert.match(
    gamesPageSource,
    /if \(!usePublicCreateWizard \|\| step !== "create"\) return;[\s\S]*window\.scrollTo\(\{ top: 0, left: 0, behavior: "auto" \}\);[\s\S]*window\.setTimeout\(resetScrollPosition, 80\);/,
  );
  assert.match(gamesPageSource, /Оплачиваю только \$\{splitSharePartLabel\} часть · \$\{formatPrice\(splitShareAmount\)\} ₽/);
  assert.doesNotMatch(gamesPageSource, /publicCreateRatingMinWheelRef/);
  assert.doesNotMatch(gamesPageSource, /publicCreateRatingMaxWheelRef/);
  assert.doesNotMatch(gamesPageSource, /handlePublicCreateLevelDone/);
  assert.doesNotMatch(gamesPageSource, /Кто сможет присоединиться\?/);
  assert.doesNotMatch(gamesPageSource, /С вас/);
  assert.doesNotMatch(gamesPageSource, /Выберите, будет ли игра видна всем или игра приглашённым/);
  assert.doesNotMatch(gamesPageSource, /renderPublicCreateVisibilityFeatureIcon/);
  assert.doesNotMatch(gamesPageSource, /renderPublicCreateVisibilityVisual/);
  assert.doesNotMatch(gamesPageSource, /className="game-create-visibility-card-intro"/);
  assert.doesNotMatch(gamesPageSource, /game-create-level-range-handle/);
  assert.doesNotMatch(gamesPageSource, /настроить точнее/);
  assert.doesNotMatch(gamesPageSource, /publicCreatePaymentMethodHelperText/);
  assert.doesNotMatch(gamesPageSource, /publicCreateAutoStationCommunityId/);
  assert.doesNotMatch(gamesPageSource, /defaultSelectedIds: usePublicCreateWizard && !isPrivate/);
  assert.doesNotMatch(gamesPageSource, /game-autopublish-card--general-list[\s\S]{0,280}setIsPrivate\(!event\.target\.checked\);/);
  assert.doesNotMatch(gamesPageSource, /className="game-input game-textarea"[\s\S]{0,220}?required/);
  assert.doesNotMatch(gamesPageSource, /game-payment-choice-card--subscription[\s\S]{0,320}?game-payment-choice-price/);
  assert.doesNotMatch(gamesPageSource, /Выбран: \$\{selectedSplitSubscriptionOption/);
  assert.doesNotMatch(gamesPageSource, /usePublicCreateWizard \? publicCreateTimeStepAmountLabel : paymentBookingAmount/);
  assert.doesNotMatch(gamesPageSource, /Стоимость корта:/);
  assert.doesNotMatch(gamesPageSource, /Вы оплачиваете весь корт; будет создана приватная игра, пригласить участников можно будет только по ссылке\./);
  assert.doesNotMatch(gamesPageSource, /!isBookingPresetMode && \(\s*<div className="team-card">\s*<div className="game-card-title">Команда<\/div>/);
});

test("public game create styling keeps friendship chips and new rating range styles", () => {
  assert.match(myAppCssSource, /\.duration-chip--friendship:not\(\.active\)/);
  assert.match(myAppCssSource, /\.duration-chip--friendship:not\(\.active\) \{[\s\S]*?background: var\(--subscription-bubble-fill\);/);
  assert.match(myAppCssSource, /\.date-chip--friendship:not\(\.active\) \.booking-date-badge/);
  assert.match(myAppCssSource, /\.date-chip--friendship:not\(\.active\) \.booking-date-badge-day/);
  assert.match(myAppCssSource, /\.game-create-summary-card--review \.game-create-summary-meta-row/);
  assert.match(myAppCssSource, /\.game-create-summary-card \.game-card-title \{[\s\S]*?font-size: 15px;/);
  assert.match(myAppCssSource, /\.game-create-level-card \.game-card-title \{[\s\S]*?font-size: 15px;/);
  assert.match(myAppCssSource, /\.game-create-level-heading \{/);
  assert.match(myAppCssSource, /\.game-create-level-summary \{[\s\S]*?font-size: 12px;[\s\S]*?white-space: nowrap;/);
  assert.match(myAppCssSource, /\.game-create-payment-card \.game-card-title \{[\s\S]*?font-size: 15px;/);
  assert.match(myAppCssSource, /\.game-create-visibility-card \.game-card-title \{[\s\S]*?font-size: 15px;/);
  assert.match(myAppCssSource, /\.game-payment-choice-card--payer \.game-payment-choice-price--discounted \{[\s\S]*?text-decoration: line-through;/);
  assert.match(myAppCssSource, /\.game-create-level-compact-panel \{/);
  assert.match(myAppCssSource, /\.game-create-level-option-title \{[\s\S]*?font-size: 17px;/);
  assert.match(myAppCssSource, /\.game-create-level-range-strip\.is-inactive \{/);
  assert.match(myAppCssSource, /\.game-visibility-option-title \{[\s\S]*?font-size: 17px;/);
  assert.match(myAppCssSource, /\.game-visibility-option-title-row \{/);
  assert.match(myAppCssSource, /\.game-payment-choice-card--payer \.game-payment-choice-copy strong \{[\s\S]*?font-size: 17px;/);
  assert.match(myAppCssSource, /\.game-publish-field-label \{[\s\S]*?font-size: 15px;/);
  assert.match(myAppCssSource, /\.game-create-level-range-strip \{/);
  assert.match(myAppCssSource, /\.game-create-level-range-segment\.is-selected \{/);
  assert.match(myAppCssSource, /\.game-create-level-precise-trigger \{/);
  assert.match(myAppCssSource, /\.game-create-precise-rating-modal-row \{/);
  assert.match(myAppCssSource, /\.game-create-visibility-options \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(myAppCssSource, /\.game-payment-choice-card\.game-visibility-option \{[\s\S]*?grid-template-columns: 24px minmax\(0, 1fr\);/);
  assert.match(myAppCssSource, /\.game-visibility-option-pill \{[\s\S]*?grid-template-columns: 16px minmax\(0, 1fr\) 16px;[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;[\s\S]*?white-space: nowrap;/);
  assert.match(myAppCssSource, /\.game-payment-choice-card\.game-visibility-option:not\(\.selected\) \.game-visibility-option-pill \{/);
  assert.match(myAppCssSource, /\.game-visibility-option-pill-label \{/);
  assert.match(myAppCssSource, /\.game-autopublish-card-avatar--square \{/);
  assert.match(myAppCssSource, /\.game-autopublish-card-avatar--square \.game-autopublish-card-avatar-image \{/);
  assert.match(myAppCssSource, /\.game-autopublish-card--readonly \{/);
  assert.match(myAppCssSource, /\.game-autopublish-card--readonly\.is-selected \.game-autopublish-card-check \{/);
  assert.match(
    myAppCssSource,
    /\.game-create-level-option\.selected \.game-payment-choice-radio::after \{[\s\S]*?content: "";/,
  );
  assert.doesNotMatch(myAppCssSource, /\.game-visibility-option-inline-icon/);
});

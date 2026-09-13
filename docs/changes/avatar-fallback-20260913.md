# Avatar image failure fallback

Broken player, trainer and author photos now render white initials on profile purple (#7353D9).
The shared component keeps the img element and existing geometry/rings, escapes text in a local SVG, and retries when the source URL changes. Unknown names use ?. Existing empty-slot and missing-photo layouts stay intact.

## Changed files
- `src/academy/AcademyCabinet.tsx`
- `src/components/cabinet/Cabinet.tsx`
- `src/components/cabinet/CommunitiesSection.tsx`
- `src/components/cabinet/ProfileEditForm.tsx`
- `src/components/cabinet/TournamentDetailsModal.tsx`
- `src/components/cabinet/community-feed/AvatarImageOrInitials.tsx`
- `src/components/cabinet/community-feed/CommunityNewsModal.tsx`
- `src/components/cabinet/community-feed/CommunityTournamentCard.tsx`
- `src/components/cabinet/community-feed/CommunityUserJoinedCard.tsx`
- `src/components/games/FindGamePage.tsx`
- `src/components/games/GamesPage.tsx`
- `src/components/group-schedule/GroupSchedulePage.tsx`
- `src/components/tournament-signup/TournamentSignupPage.tsx`
- `src/components/tournaments/TournamentsPage.tsx`
- `src/components/UI/AvatarImage.tsx`
- `src/components/UI/avatarFallback.ts`
- `scripts/tests/avatarFallback.test.ts`

## Validation
- `node --experimental-strip-types --test scripts/tests/avatarFallback.test.ts`: 2 passed.
- `npx tsc -b`: passed.
- Scoped ESLint: no errors, 18 warnings in existing components.
- `npm run build`: all production and development bundles passed using ignored local build env files.
- Tournament production/development bundles rebuilt after the pair-avatar overlay correction.
- Independent UI review: duplicate initials in tournament pair fixed.
- Local Playwright fixture with real CSS: seven images, no broken images; Cyrillic initials, missing name/source, failed-valid-failed URL sequence; 390x844 and 1280x900 screenshots. Record avatar remains 35x35.

## Limits
Browser evidence is from a local component fixture, not authenticated production pages. Live Tilda and overlay mount/unmount flows were not retested. No merge, deploy or live data changes.

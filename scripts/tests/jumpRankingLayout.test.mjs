import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screen = readFileSync('src/components/cabinet/community-feed/CommunityJumpRankingScreen.tsx', 'utf8');
const css = readFileSync('src/components/cabinet/community-feed/community-jump-ranking.css', 'utf8');

test('the jump play action stays above the empty state and results', () => {
  const rules = screen.indexOf('community-jump-rules');
  const play = screen.indexOf('community-jump-play');
  const results = screen.indexOf('CommunityJumpRankingResults', play);
  const refresh = screen.indexOf('community-jump-refresh', results);
  assert.ok(rules >= 0 && play > rules, 'play must follow the rating-rules block');
  assert.ok(results > play, 'play must be above the results/empty-state renderer');
  assert.ok(refresh > results, 'refresh stays at the bottom of the ranking card');
  assert.match(css, /\.community-jump-play \{[^}]*margin-top: 16px/);
});

test('the notification bell sits under play, only for the exhibition, as a quieter action', () => {
  const play = screen.indexOf('community-jump-play');
  const notify = screen.indexOf('community-jump-notify', play);
  const search = screen.indexOf('community-jump-search', notify);
  assert.ok(notify > play, 'the bell must follow the play button');
  assert.ok(search > notify, 'play and the bell stay above the search and results');
  assert.match(screen, /community\.id === EXHIBITION_COMMUNITY_ID && <a className="community-jump-notify"/);
  assert.match(screen, /buildExhibitionPushOptInUrl\(exhibitionCommunityUrl\(community\.id\), community\.id\)/);
  assert.match(screen, /<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/);
  assert.match(css, /\.community-jump-notify \{[^}]*border: 1px solid var\(--phr-line\)/);
  assert.match(css, /\.community-jump-notify \{[^}]*background: var\(--phr-surface\)/);
  assert.match(css, /\.community-jump-notify \{[^}]*margin-top: 8px/);
});

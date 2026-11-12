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

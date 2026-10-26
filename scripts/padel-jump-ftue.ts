/** Reproducible simulation seconds, not accelerated wall-clock time or observed human performance. */
import assert from 'node:assert/strict';
import { createCampaignGame, FIXED_STEP } from '../src/components/padel-jump/engine.ts';
import { BALANCE } from '../src/components/padel-jump/campaign.ts';
import { createVisit } from '../src/components/padel-jump/session.ts';
import { finishPart, freshProgress, recordFailure } from '../src/components/padel-jump/progress.ts';
import { pilot } from './tests/helpers/padelJumpPilot.ts';
export function ftue(errors = false) {
  const clock = createVisit('simulation'), p = freshProgress(); clock.start();
  // Explicit test input: 4 seconds for visible permission/calibration, 2 seconds to press Retry.
  clock.advance(4, true, false, false);
  const sections: number[] = []; let firstStar: number | null = null, firstLanding: number | null = null;
  for (let n = 0; n < 3; n++) {
    const attempts = errors && n < 2 ? [true, false] : [false];
    for (const mistake of attempts) {
      const g = createCampaignGame(0, n); const before = clock.times().visibleSeconds;
      pilot(g, { ...(mistake ? { failAt: 4 } : {}), onEvent(event, state) {
        if (event.type === 'star' && firstStar === null) firstStar = before + state.time;
        if (event.type === 'landing' && event.controlled && firstLanding === null) firstLanding = before + state.time;
      } });
      clock.advance(g.time, true, false, true);
      if (mistake) { assert.equal(g.mode, 'over'); recordFailure(p, g); clock.advance(2, true, false, false); }
      else { assert.equal(g.mode, 'complete'); finishPart(p, g); sections.push(g.time); }
    }
    clock.advance(BALANCE.intermission, true, false, false);
  }
  assert.equal(p.unlocked, 1);
  const ready = clock.times(); const seliger = createCampaignGame(1, 0); pilot(seliger, { untilMoving: true });
  clock.advance(seliger.time, true, false, true);
  const result = { errors: errors ? 2 : 0, firstStar, firstLanding, yasenevoSections: sections, seligerReady: ready,
    seligerFirstMovingLanding: clock.times(), movingLandings: seliger.campaign!.movingLandings, simulationStep: FIXED_STEP };
  assert.ok(ready.visibleSeconds <= 120); assert.ok(clock.times().visibleSeconds <= 120); assert.ok(firstStar !== null && firstStar <= 10);
  return result;
}
console.log(JSON.stringify({ balance: BALANCE.version, assumptions: 'fixed-step simulation; visible setup 4s, each retry reaction 2s; mistakes hold wrong edge after 4s in sections 1 and 2; ideal predictive pilot otherwise', scenarios: [ftue(), ftue(true)] }, null, 2));

/**
 * Offline demonstration runs for the spectator wall. They use the real campaign
 * engine and renderer with an autopilot, run only in the viewer's browser, are
 * always labelled as a demo, and never reach the ranking or any server.
 */
import { FIXED_STEP, createCampaignGame, stepGame } from '../engine.ts';
import { STATIONS } from '../campaign.ts';
import { autopilotDirection } from './smooth-motion.mjs';

const CHECKPOINT_S = 1.6, RETRY_S = 1.4, ELIMINATED_S = 1.6, MAX_CATCH_UP_S = 0.25;

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * One demo attempt sequence: sections in campaign order from `station`, with
 * `misses` scripted misses (one per attempt, at a random landing) so lives and retries show.
 */
export function createDemoRun({ runId, name, station = 0, section = 0, sections = 3, lives = 5, seed = 1, misses = 0, startAt = 0 }) {
  const random = mulberry(seed);
  let game = null, phase = 'playing', phaseLeft = 0, generation = 0, seq = 0, clock = 0, elapsed = 0;
  let livesLeft = lives, stars = 0, done = 0, landings = 0, finishedAt = null, missesLeft = misses, missAt = 0, peak = 0, progressAt = 0;
  const memory = { landY: -Infinity, bias: 0 };
  let current = { station, section };
  function begin() {
    game = createCampaignGame(current.station, current.section);
    game.mode = 'running'; generation++; phase = 'playing';
    memory.landY = -Infinity; memory.bias = 0; landings = 0; peak = game.peak; progressAt = clock;
    missAt = missesLeft > 0 ? 6 + Math.floor(random() * 18) : 0;
  }
  begin();
  function advanceSection() {
    done++;
    stars += game.campaign.stars.filter(s => s.collected).length;
    if (done >= sections) { phase = 'finished'; finishedAt = clock; generation++; return; }
    current = current.section < 2 ? { station: current.station, section: current.section + 1 }
      : { station: Math.min(STATIONS.length - 1, current.station + 1), section: 0 };
    phase = 'checkpoint'; phaseLeft = CHECKPOINT_S; generation++;
  }
  function step(dt) {
    clock += dt;
    if (phase === 'finished') return;
    elapsed += dt;
    if (phase !== 'playing') {
      phaseLeft -= dt;
      if (phaseLeft > 0) return;
      if (phase === 'eliminated') { phase = 'finished'; finishedAt = clock; generation++; return; }
      begin(); return;
    }
    stepGame(game, autopilotDirection(game, memory), dt);
    if (game.peak > peak + 1) { peak = game.peak; progressAt = clock; }
    else if (clock - progressAt > 4) {
      // Stuck below collapsed rackets after a miss: let the supports crumble so the engine registers the fall.
      for (const p of game.platforms) if (p.spent === undefined && p.y < game.ball.y) p.spent = 0;
      progressAt = clock;
    }
    for (const event of game.events.splice(0)) {
      if (event.type !== 'landing') continue;
      landings++;
      const platform = game.platforms.find(p => String(p.id) === event.id);
      if (platform) memory.landY = platform.y;
      // A scripted miss steers past the next support; the engine decides the fall.
      const miss = missAt && landings === missAt;
      if (miss) missesLeft--;
      memory.bias = miss ? (random() < 0.5 ? -4.5 : 4.5) : (random() - 0.5);
    }
    if (game.mode === 'complete') advanceSection();
    else if (game.mode === 'over') {
      livesLeft--; generation++;
      if (livesLeft <= 0) { phase = 'eliminated'; phaseLeft = ELIMINATED_S; stars += game.campaign.stars.filter(s => s.collected).length; }
      else { phase = 'retry'; phaseLeft = RETRY_S; }
    }
  }
  return {
    runId, name, startAt, initialLives: lives, demo: true,
    get finished() { return phase === 'finished'; },
    get finishedAt() { return finishedAt; },
    get stars() { return stars + (phase === 'playing' ? game.campaign.stars.filter(s => s.collected).length : 0); },
    get elapsedMs() { return Math.round(elapsed * 1000); },
    /** Advance to demo time `seconds` (bounded catch-up), then describe the frame. */
    frameAt(seconds) {
      const target = seconds - startAt;
      if (target < 0) return null;
      let budget = MAX_CATCH_UP_S;
      while (clock + FIXED_STEP <= target && budget > 0) { step(FIXED_STEP); budget -= FIXED_STEP; }
      if (clock + FIXED_STEP <= target) clock = target; // hidden tab: skip, never fast-forward a backlog
      seq++;
      const status = phase === 'finished' ? 'finished' : 'running';
      const shownPhase = phase === 'finished' ? 'finished' : phase;
      const confirmed = { runId, seq, t: Math.round(clock * 1000), x: game.ball.x, y: game.ball.y, score: this.stars, lives: livesLeft,
        elapsedMs: this.elapsedMs, segmentId: `${runId}:${generation}`, status, phase: shownPhase, station: game.campaign.station, section: game.campaign.section };
      return { runId, state: status === 'finished' ? 'finished' : 'playing', stale: false, transition: null, playbackTimeMs: confirmed.t,
        pose: { x: game.ball.x, y: game.ball.y, mode: 'demo' }, game, confirmed };
    },
  };
}

const NAMES = ['Алексей', 'Мария', 'Тимур', 'Ольга', 'Дмитрий', 'Екатерина', 'Илья', 'Софья'];

/** Five fixed scenarios for the offline videos, plus an endless in-page loop. */
export const DEMO_SCENARIOS = Object.freeze({
  1: { title: 'Один игрок', runs: [{ station: 0, section: 0, sections: 3, misses: 1 }] },
  2: { title: 'Двое на экране', runs: [{ station: 2, section: 0, sections: 3, misses: 1 }, { station: 4, section: 0, sections: 2, misses: 2, startAt: 2 }] },
  3: { title: 'Трое, с потерей жизней', runs: [{ station: 0, section: 1, sections: 2 }, { station: 3, section: 0, sections: 2, misses: 5, startAt: 3 }, { station: 6, section: 0, sections: 2, misses: 2, startAt: 6 }] },
  4: { title: 'Четыре игрока', runs: [{ station: 5, section: 0, sections: 2, misses: 1 }, { station: 6, section: 0, sections: 2 }, { station: 7, section: 0, sections: 2, misses: 3, startAt: 1 }, { station: 8, section: 0, sections: 2, startAt: 4 }] },
  5: { title: 'Рейтинг и новый игрок', runs: [{ station: 0, section: 0, sections: 2, startAt: 14 }, { station: 2, section: 1, sections: 2, misses: 2, startAt: 24 }] },
});

export const DEMO_LEADERBOARD = Object.freeze([
  ['Анна', 31, 214300], ['Кирилл', 29, 198700], ['Елена', 27, 233100], ['Максим', 26, 187900], ['Наталья', 24, 205400],
  ['Георгий', 22, 176200], ['Полина', 21, 199800], ['Роман', 19, 168500], ['Виктория', 18, 221000], ['Артём', 16, 154300],
  ['Дарья', 15, 171900], ['Павел', 13, 149600], ['Юлия', 12, 162800], ['Сергей', 10, 133400],
].map(([name, score, elapsedMs], index) => Object.freeze({ id: `demo-${index}`, name, score, elapsedMs })));

/**
 * A demo "show": the roster changes over time like a real wall. `loop` restarts
 * finished players with fresh ones so a TV can run it indefinitely.
 */
export function createDemoShow(scenario = 'loop', { seed = 7 } = {}) {
  const loop = scenario === 'loop';
  const plan = loop ? { runs: [{ station: 0, section: 0, sections: 3, misses: 2 }, { station: 2, section: 0, sections: 3, misses: 1, startAt: 5 }] } : DEMO_SCENARIOS[scenario];
  if (!plan) throw new RangeError('Unknown demo scenario');
  let made = 0;
  const make = (spec, startAt) => createDemoRun({ runId: `demo-run-${scenario}-${made}`, name: NAMES[(made + Number(seed)) % NAMES.length], seed: seed * 97 + made++, ...spec, startAt });
  let runs = plan.runs.map(spec => make(spec, spec.startAt ?? 0));
  return {
    title: plan.title,
    /** Visible players at demo time `seconds`; finished runs stay ten seconds. */
    players(seconds) {
      if (loop) runs = runs.flatMap(run => run.finished && run.finishedAt !== null && seconds - run.startAt - run.finishedAt > 10
        ? [make({ station: [0, 2, 3, 4, 6, 7][made % 6], section: 0, sections: 3, misses: made % 3 }, seconds + 2)] : [run]);
      return runs.filter(run => seconds >= run.startAt && !(run.finished && seconds - run.startAt - run.finishedAt > 10));
    },
  };
}

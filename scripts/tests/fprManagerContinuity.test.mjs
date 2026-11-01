import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build, transform } from 'esbuild';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const page = readFileSync('src/components/tournaments/TournamentsPage.tsx', 'utf8');
const handlers = page.slice(page.indexOf('  const handleManagerDataChange = ('), page.indexOf('  const handleManagerEditSettings = ()'));
const binding = page.match(/<FprTournamentManager\b[\s\S]*?onDataChange=\{([^\n]+)\}/)?.[1];
assert.ok(binding, 'actual FPR manager callback must be wired');
const callback = await transform(`export function fixture(payload, initialSelected) {
  let manager = payload, selected = initialSelected;
  const extras = { totals: null, playerLogs: null };
  const visibleTournaments = [{ id: payload.tournamentId }], items = [], combinedHistoryById = {};
  let selectedTournament = initialSelected;
  const buildTournamentHistoryRecordFromPayload = value => value;
  const saveCachedTournamentHistory = async () => {};
  const upsertLocalDraftSnapshot = () => {};
  const setHistoryById = () => {};
  const setManagerData = value => { manager = value; };
  const setSelectedTournament = value => { selected = value; };
  const setManagerTotals = () => {}, setManagerPlayerLogs = () => {};
  ${handlers}
  const save = ${binding};
  return { save, get manager() { return manager; }, get selected() { return selected; } };
}`, { loader: 'ts', format: 'cjs' });
const callbacks = { exports: {} };
new Function('module', 'exports', callback.code)(callbacks, callbacks.exports);

test('actual parent score callback updates the same manager without reopening source or local-draft settings', () => {
  for (const selected of [null, { id: 'source-exercise' }]) {
    const h = callbacks.exports.fixture({ tournamentId: 'fpr-continuity' }, selected);
    for (let revision = 1; revision <= 3; revision++) {
      const next = { tournamentId: 'fpr-continuity', params: { fpr6x25: { revision } } };
      h.save(next);
      assert.equal(h.manager, next);
      assert.equal(h.selected, selected, 'saving a score must not select the synthetic local exercise');
    }
  }
});

test('settings dialog cannot cover an active manager; explicit editing still opens settings after closing manager', async () => {
  const expression = page.match(/<TournamentDetailsModal\s+isOpen=\{([^\n]+)\}/)?.[1];
  assert.ok(expression);
  const visible = new Function('managerData', 'selectedTournament', 'manualTournamentCreationOpen', `return ${expression}`);
  for (const selected of [null, { id: 'source-exercise' }]) {
    for (const manual of [false, true]) assert.equal(visible({ tournamentId: 'fpr-continuity' }, selected, manual), false);
  }
  assert.equal(visible(null, { id: 'source-exercise' }, false), true);
  assert.equal(visible(null, null, true), true);
  assert.equal(visible(null, null, false), false);
});

const compiled = await build({ stdin: { contents: `export { FprTournamentManager } from './src/components/tournaments/FprTournamentPanel'; export * from './src/components/tournaments/fpr6x25';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': '{}' }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' }, logLevel: 'silent' });
const components = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, components, components.exports);
const { createFprState, applyFprCommand, fprProjection, FprTournamentManager } = components.exports;

test('completed rounds render expanded with scores in chronological order through finish and reload', () => {
  const now = new Date().toISOString();
  let state = createFprState({ tournamentId: 'fpr-continuity', players: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, level: 3, leaguePlace: i + 1, leaguePoints: i })), courts: ['Court 1', 'Court 2'], leagueSource: 'Synthetic', now, endsAt: new Date(Date.now() + 3600000).toISOString(), reserveAllowed: false });
  const act = action => { state = applyFprCommand(state, { ...action, id: `command-${state.revision}`, expectedRevision: state.revision }, now); };
  const render = () => renderToStaticMarkup(React.createElement(FprTournamentManager, { data: { tournamentId: state.tournamentId, tournamentType: 'fpr_6x25', participants: state.players, courts: state.courts, organizer: { id: 'synthetic-organizer' }, ...fprProjection(structuredClone(state)) }, onClose() {}, onDataChange() {} }));
  for (let round = 1; round <= 6; round++) {
    for (const match of state.attempts.at(-1).matches) act({ action: 'score', matchId: match.id, score1: 18, score2: 7, confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true });
    const html = render();
    for (let previous = 1; previous <= round; previous++) {
      assert.ok(html.includes(`<section aria-label="Раунд ${previous} · попытка ${previous}" class="tournament-round saved">`));
      assert.ok(!html.includes('<details class="tournament-round'));
      if (previous < round) assert.ok(html.indexOf(`Раунд ${previous} · попытка ${previous}`) < html.indexOf(`Раунд ${previous + 1} · попытка ${previous + 1}`));
    }
    assert.equal((html.match(/value="18"/g) ?? []).length, round * 2);
    assert.equal((html.match(/value="7"/g) ?? []).length, round * 2);
  }
  act({ action: 'finish' });
  assert.equal(state.status, 'completed');
  const finished = render();
  assert.equal((finished.match(/class="tournament-round saved"/g) ?? []).length, 6);
  assert.equal((finished.match(/value="18"/g) ?? []).length, 12);
});

import fs from 'node:fs';
import vm from 'node:vm';
import { applyFprCommand, fprProjection } from '../../src/components/tournaments/fpr6x25.ts';
import { isAutoFinishProtocolClosed, tournamentAutoFinishDurationMs } from './tournamentAutoFinishNodes.mjs';
import { buildTournamentWriteSnapshot, tournamentWriteFilter } from './communityMonthlyFinalization.mjs';

// Recalculation refreshes derived match.results and round.summary, never score facts.
export function tournamentRoundFacts(rounds) {
  return (rounds || []).map(round => {
    const facts = { ...round };
    delete facts.summary;
    return { ...facts, byes: round.byes || [], matches: (round.matches || []).map(match => {
      const scores = { ...match };
      delete scores.results;
      return scores;
    }) };
  });
}
export const TOURNAMENT_AUTO_FINISH_MS = 3 * 60 * 60 * 1000;
export function planTournamentAutoFinish(tournament, nowTs, recalculateSource) {
  const skip = reason => ({ close: false, reason });
  const lifecycle = tournament.params?.autoFinish;
  if (lifecycle?.version !== 1) return skip('NOT_MANAGED');
  const fpr = tournament.tournamentType === 'fpr_6x25';
  if (fpr ? ['completed', 'incomplete'].includes(tournament.params?.fpr6x25?.status) : isAutoFinishProtocolClosed(tournament)) return skip('ALREADY_FINISHED');
  if (tournament.archived === true || tournament.cancelled === true || tournament.canceled === true) return skip('INACTIVE');
  const sessionStart = Date.parse(lifecycle.resumedAt || lifecycle.startedAt);
  const deadline = Date.parse(lifecycle.deadlineAt);
  const durationMs = tournamentAutoFinishDurationMs(tournament);
  if (!Number.isInteger(lifecycle.session) || lifecycle.session < 1 || !Number.isFinite(sessionStart)
      || (lifecycle.durationMs ?? TOURNAMENT_AUTO_FINISH_MS) !== durationMs
      || deadline !== sessionStart + durationMs) return skip('INVALID_SERVER_DEADLINE');
  if (nowTs < deadline) return skip('NOT_DUE');
  const nowIso = new Date(nowTs).toISOString();
  const nextLifecycle = { ...lifecycle, reason: 'time_limit', processedAt: nowIso };
  let set;
  if (fpr) {
    const previous = tournament.params.fpr6x25;
    const command = { action: 'finish', id: `auto-finish:${lifecycle.session}:${deadline}`, expectedRevision: previous.revision };
    const state = applyFprCommand(previous, command, nowIso);
    const projection = fprProjection(state, tournament.params);
    const { params, ...fields } = projection;
    set = { ...fields, updatedAt: nowIso, 'params.autoFinish': nextLifecycle };
    // Preserve broadcast/integration metadata and the isolated FPR rating contract.
    for (const [key, value] of Object.entries(fprProjection(state, {}).params)) set['params.' + key] = value;
    void params;
  } else {
    if (!recalculateSource) return skip('RECALCULATOR_MISSING');
    const matches = (tournament.rounds || []).flatMap(r => r.matches || []);
    const complete = matches.filter(m => m.score1 != null && m.score2 != null);
    if (complete.some(m => [m.score1, m.score2].some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 0))) return skip('INVALID_SAVED_SCORE');
    const finishedAt = new Date(deadline).toISOString();
    const msg = { payload: [structuredClone(tournament)], _tournamentAutoFinishInternal: true,
      req: { body: { results: [], params: { status: 'completed', finished: true, manualFinish: true, finishedAt, completedAt: finishedAt } } } };
    const result = new vm.Script(`(function(msg) { ${recalculateSource}\n})(msg)`).runInNewContext({ msg }, { timeout: 5000 });
    set = result?.mongoUpdate?.$set;
    if (!set || JSON.stringify(tournamentRoundFacts(set.rounds)) !== JSON.stringify(tournamentRoundFacts(tournament.rounds))) return skip('RECALCULATION_CHANGED_ROUNDS');
    set.params = { ...set.params, autoFinish: nextLifecycle };
    set.updatedAt = nowIso;
    if (!complete.length) { set.standings = []; set.totals = {}; set.playerLogs = {}; }
  }
  return { close: true, reason: 'TIME_LIMIT', set,
    filter: tournamentWriteFilter(tournament.tournamentId, buildTournamentWriteSnapshot(tournament)) };
}

export async function applyTournamentAutoFinish(collection, tournament, plan, backupDir) {
  if (!plan.close) return { applied: false, reason: plan.reason };
  if (!backupDir) throw new Error('AUTO_FINISH_BACKUP_REQUIRED');
  const { BSON } = await import('mongodb');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const target = `${backupDir}/${encodeURIComponent(tournament.tournamentId)}-${tournament.params.autoFinish.session}.ejson`;
  // Each sweep has its own directory; a different preimage must never replace a backup.
  const bytes = BSON.EJSON.stringify(tournament, { relaxed: false });
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== bytes) throw new Error('AUTO_FINISH_BACKUP_CONFLICT');
  if (!fs.existsSync(target)) {
    const fd = fs.openSync(target, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dirFd = fs.openSync(backupDir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  }
  const result = await collection.updateOne(plan.filter, { $set: plan.set }, { maxTimeMS: 5000 });
  if (result.acknowledged !== true) throw new Error('AUTO_FINISH_WRITE_NOT_ACKNOWLEDGED');
  if (result.matchedCount !== 1) return { applied: false, reason: 'SOURCE_CHANGED' };
  const saved = await collection.findOne({ _id: tournament._id });
  if (saved?.params?.autoFinish?.reason !== 'time_limit'
      || saved.params.autoFinish.session !== tournament.params.autoFinish.session) throw new Error('AUTO_FINISH_POSTCHECK_FAILED');
  return { applied: true, reason: 'TIME_LIMIT' };
}

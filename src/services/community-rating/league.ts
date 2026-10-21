import { communityType, parseCommunityTypeSettings, resolveLeagueDivision, type LeagueDivision } from '../community-policy.ts';
import { buildCommunityRatingSnapshot, type CommunityRatingSnapshot } from './aggregates.ts';
import type { CommunityRatingFact } from './facts.ts';

export interface LeagueResultAssignment {
  _id: string; communityId: string; factId: string; eventId: string; eventType: string; playerKey: string;
  division: LeagueDivision | null; levelAtEvent: number | null; settingsRevision: number; assignedAt: string;
}
export type LeagueRatingFact = CommunityRatingFact & { leagueDivision?: LeagueDivision | null; leagueLevelAtEvent?: number | null };
export interface LeagueRatingTable { id: string; name: string; rows: CommunityRatingSnapshot['rows'] }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const leagueAssignmentKey = (fact: Pick<CommunityRatingFact, 'communityId' | 'eventType' | 'eventId' | 'playerKey'>) =>
  [fact.communityId, fact.eventType, fact.eventId, fact.playerKey].map(encodeURIComponent).join(':');
const numeric = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function eventLevel(fact: CommunityRatingFact, events: Record<string, unknown>[], records: Record<string, unknown>[]): number | null {
  const ledger = events.filter(event => fact.ratingEventIds.includes(String(event.id ?? event._id)))
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || String(a.id).localeCompare(String(b.id)));
  for (const event of ledger) { const before = numeric(object(object(event.source).tournamentRatingSnapshot).before) ?? numeric(object(event.change).before); if (before !== null) return before; }
  const source = records.find(row => [row.id, row.gameId, row.tournamentId, row.exerciseId, row.sourceTournamentId].includes(fact.eventId));
  if (!source || !fact.playerId) return null;
  const rating = object(source.rating), result = object(source.result);
  const players = [source.organizer, ...list(source.participants), ...list(source.players), ...list(source.finalStandings), ...list(rating.finalStandings), ...list(result.standings)];
  for (const raw of players) {
    const player = object(raw);
    if (![player.id, player.clientId, player.playerId].includes(fact.playerId)) continue;
    const before = numeric(player.ratingBefore) ?? numeric(player.ratingNumeric) ?? numeric(player.levelScore);
    if (before !== null) return before;
  }
  // Current profile level is not proof of the player's level at a past event.
  return null;
}
export function assignLeagueResults(input: {
  community: Record<string, unknown>; facts: CommunityRatingFact[];
  existing?: LeagueResultAssignment[]; ratingEvents: Record<string, unknown>[];
  records: Record<string, unknown>[]; nowIso: string;
}): { facts: LeagueRatingFact[]; assignments: LeagueResultAssignment[] } {
  const previous = new Map((input.existing ?? []).map(row => [row._id, row]));
  const assignments: LeagueResultAssignment[] = [];
  let divisions: LeagueDivision[] | null = null;
  const effectiveAt = Date.parse(String(input.community.typeSettingsEffectiveAt ?? ''));
  if (communityType(input.community.communityType) === 'LEAGUE') {
    divisions = parseCommunityTypeSettings('LEAGUE', input.community.typeSettings).divisions!;
  }
  const facts = input.facts.map(fact => {
    let assignment = previous.get(leagueAssignmentKey(fact));
    const eventTs = fact.eventType === 'tournament' ? fact.eventStartedAtTs ?? fact.occurredAtTs : fact.occurredAtTs;
    if (!assignment && divisions && Number.isFinite(effectiveAt) && eventTs >= effectiveAt) {
      const levelAtEvent = eventLevel(fact, input.ratingEvents, input.records);
      const division = resolveLeagueDivision(divisions, levelAtEvent);
      assignment = { _id: leagueAssignmentKey(fact), factId: fact.id, communityId: fact.communityId, eventId: fact.eventId, eventType: fact.eventType, playerKey: fact.playerKey,
        division, levelAtEvent, settingsRevision: Number(input.community.typeSettingsRevision) || 0, assignedAt: input.nowIso };
      assignments.push(assignment);
    }
    return assignment ? { ...fact, leagueDivision: assignment.division, leagueLevelAtEvent: assignment.levelAtEvent } : fact;
  });
  return { facts, assignments };
}

export function buildLeagueRatingTables(snapshot: CommunityRatingSnapshot, facts: LeagueRatingFact[], configured: LeagueDivision[] = []): LeagueRatingTable[] {
  const divisions = new Map(configured.map(division => [division.id, division.name]));
  facts.forEach(fact => { if (fact.leagueDivision && !divisions.has(fact.leagueDivision.id)) divisions.set(fact.leagueDivision.id, fact.leagueDivision.name); });
  return [...divisions].map(([id, name]) => ({ id, name, rows: buildCommunityRatingSnapshot({
    communityId: snapshot.communityId, facts: facts.filter(fact => fact.leagueDivision?.id === id),
    period: snapshot.period, tab: snapshot.tab, nowTs: snapshot.updatedAtTs, updatedAt: snapshot.updatedAt,
    calculationVersion: snapshot.calculationVersion,
  }).rows }));
}

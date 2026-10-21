import type { PadelPlayerCandidate } from './apiClient';

const CLIENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const isStableTournamentClientId = (value: unknown): value is string =>
  typeof value === 'string' && CLIENT_ID.test(value.trim());

const phoneKey = (value: string | null | undefined) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `7${digits}`;
  return digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
};

// This is a view over an already visible roster, never a CRM directory request.
export function searchTournamentRosterPlayers(query: string, roster: readonly PadelPlayerCandidate[], limit = 8) {
  const text = query.trim().toLocaleLowerCase('ru');
  if (text.length < 2) return [];
  const digits = phoneKey(text);
  const byId = new Map<string, PadelPlayerCandidate>();
  for (const player of roster) {
    const id = player.id?.trim();
    if (!id || !isStableTournamentClientId(id)) continue;
    if (!player.name.toLocaleLowerCase('ru').includes(text)
      && !(digits.length >= 4 && phoneKey(player.phone).includes(digits))) continue;
    byId.set(id, { ...player, id });
  }
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 8;
  return [...byId.values()].slice(0, boundedLimit);
}

export function resolveTournamentRosterPhone(phone: string, roster: readonly PadelPlayerCandidate[]) {
  const digits = phoneKey(phone);
  const matches = new Map<string, PadelPlayerCandidate>();
  if (digits.length === 11) {
    for (const player of roster) {
      const id = player.id?.trim();
      if (id && isStableTournamentClientId(id) && phoneKey(player.phone) === digits) matches.set(id, player);
    }
  }
  return { candidate: matches.size === 1 ? [...matches.values()][0] : null,
    reason: matches.size > 1 ? 'ambiguous' : matches.size === 0 ? 'missing' : null } as const;
}

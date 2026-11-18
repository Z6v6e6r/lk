// Unknown outcome of a one-time split-join payment create.
//
// A one-time create uses a fresh paymentRef per click, so the server cannot
// deduplicate a retry. When the create may have reached the provider but its
// result is unknown, a new checkout for that game stays blocked until the game
// record shows this user's split-payment item, or until the participant payment
// window has passed.

export interface SplitJoinUnknown {
  gameId: string;
  since: number;
}

/** Statuses that do not prove the create was rejected before reaching the provider. */
export function isAmbiguousCreateStatus(status: number | null | undefined): boolean {
  if (status == null || !Number.isFinite(status)) return true;
  if (status === 408) return true;
  if (status >= 500) return true;
  // A 2xx/3xx answer that could not be used (e.g. unparseable) is not a refusal.
  return status < 400;
}

export function isSplitJoinBlocked(
  unknown: SplitJoinUnknown | null,
  gameId: string | null | undefined,
  nowTs: number,
  deadlineMinutes: number,
): boolean {
  if (!unknown || !gameId || unknown.gameId !== gameId) return false;
  return nowTs < unknown.since + deadlineMinutes * 60_000;
}

/** Clear the block only with evidence, never because a read merely succeeded. */
export function canClearSplitJoinUnknown(input: {
  recordShowsUserPayment: boolean;
  unknown: SplitJoinUnknown | null;
  gameId: string;
  nowTs: number;
  deadlineMinutes: number;
}): boolean {
  if (input.recordShowsUserPayment) return true;
  return !isSplitJoinBlocked(input.unknown, input.gameId, input.nowTs, input.deadlineMinutes);
}

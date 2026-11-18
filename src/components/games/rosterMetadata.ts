const organizerAuthorityKeys = ["organizerId", "organizerPhone", "organizerPhoneNorm"] as const;

/** Ordinary roster changes must preserve the server's organizer authority snapshot. */
export function mergeRosterMetadata(
  current: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current, ...changes };
  for (const key of organizerAuthorityKeys) {
    if (Object.prototype.hasOwnProperty.call(current, key)) merged[key] = current[key];
    else delete merged[key];
  }
  return merged;
}

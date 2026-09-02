import { buildTimeForFriendsAtomicMembershipMutation } from "./timeForFriendsCommunityBackfill.mjs";

export const PUBLISHED_TOURNAMENT_JOIN_SOURCE = "PUBLISHED_TOURNAMENT_MEMBERSHIP_BACKFILL";

export function buildTimeForAtomicMembershipMutation(operation, nowIso, provenanceVersion) {
  return buildTimeForFriendsAtomicMembershipMutation({
    ...operation,
    joinSourceType: PUBLISHED_TOURNAMENT_JOIN_SOURCE,
    joinSourceVersion: provenanceVersion,
  }, nowIso);
}

export function buildCommunityRestoreReplacement(preimage, appliedAt) {
  if (!preimage || typeof preimage !== "object" || !preimage._id) {
    throw new Error("Community backup preimage with _id is required");
  }
  if (!appliedAt || typeof appliedAt !== "string") throw new Error("Applied timestamp is required");
  return {
    filter: { _id: preimage._id, updatedAt: appliedAt },
    replacement: preimage,
  };
}

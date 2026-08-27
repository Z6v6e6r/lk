import crypto from "node:crypto";
import {
  TIME_FOR_FRIENDS_DIRECTION_ID,
  buildTimeForFriendsAtomicMembershipMutation,
  collectDirectionIds,
  collectPublicationTournamentAliases,
  collectStationIds,
  collectTournamentIds,
} from "./timeForFriendsCommunityBackfill.mjs";
import { isTournamentFinalized } from "./tournamentFinalization.mjs";

export const TOURNAMENT_COMMUNITY_CONTEXT_VERSION = "tournament-community-context-v1";
export const TOURNAMENT_COMMUNITY_ENROLLMENT_VERSION = "time-for-friends-auto-enrollment-v1";

const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toStringOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const unique = (values) => Array.from(new Set(values.filter(Boolean)));
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const isArchived = (record) => record?.archived === true
  || String(record?.status || "").trim().toLowerCase() === "archived";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nested(record, path) {
  let current = record;
  for (const part of path) {
    if (!isObject(current)) return null;
    current = current[part];
  }
  return current;
}

function firstString(record, paths) {
  for (const path of paths) {
    const value = toStringOrNull(nested(record, path));
    if (value) return value;
  }
  return null;
}

function normalizePublicationRole(post) {
  const role = firstString(post, [
    ["publicationRole"],
    ["ratingRole"],
    ["details", "publicationRole"],
    ["details", "ratingRole"],
    ["details", "publicTournament", "publicationRole"],
    ["details", "publicTournament", "ratingRole"],
  ]);
  return String(role || "DISCOVERY_ONLY").trim().toUpperCase() === "RATING_PRIMARY"
    ? "RATING_PRIMARY"
    : "DISCOVERY_ONLY";
}

function resolveTournamentId(tournament, feedPosts = []) {
  const tournamentIds = collectTournamentIds(tournament);
  const publishedIds = unique(asArray(feedPosts).flatMap(collectPublicationTournamentAliases));
  const linkedIds = tournamentIds.filter((id) => publishedIds.includes(id));
  const providerIds = unique([
    toStringOrNull(tournament?.exerciseId),
    toStringOrNull(tournament?.sourceTournamentId),
  ]).filter((id) => UUID_RE.test(id) && linkedIds.includes(id));
  if (providerIds.length === 1) return providerIds[0];
  if (providerIds.length > 1) return null;
  if (linkedIds.length === 1) return linkedIds[0];
  if (linkedIds.length > 1) return null;
  return firstString(tournament, [
    ["exerciseId"],
    ["sourceTournamentId"],
    ["tournamentId"],
    ["id"],
  ]);
}

function publicationMatchesTournament(post, tournamentId) {
  return collectPublicationTournamentAliases(post).includes(tournamentId);
}

export function resolveTournamentCommunityContext({ tournament, feedPosts }) {
  const tournamentIds = collectTournamentIds(tournament);
  const publishedIds = unique(asArray(feedPosts).flatMap(collectPublicationTournamentAliases));
  const linkedIds = tournamentIds.filter((id) => publishedIds.includes(id));
  const tournamentId = resolveTournamentId(tournament, feedPosts);
  if (!tournamentId) {
    return {
      tournamentId: null,
      publishedCommunities: [],
      ratingCommunityId: null,
      ratingCommunityStatus: linkedIds.length > 1 ? "TOURNAMENT_RELATION_AMBIGUOUS" : "TOURNAMENT_ID_MISSING",
    };
  }

  const publishedCommunities = asArray(feedPosts)
    .filter((post) => (
      isObject(post)
      && !isArchived(post)
      && String(post.kind || "").trim().toUpperCase() === "TOURNAMENT"
      && publicationMatchesTournament(post, tournamentId)
    ))
    .map((post) => ({
      communityId: toStringOrNull(post.communityId),
      communityName: firstString(post, [["communityName"], ["details", "communityName"]]),
      publicationId: toStringOrNull(post.id ?? post._id),
      role: normalizePublicationRole(post),
      stationId: collectStationIds(post)[0] || null,
    }))
    .filter((row) => row.communityId)
    .sort((left, right) => (
      left.communityId.localeCompare(right.communityId)
      || String(left.publicationId || "").localeCompare(String(right.publicationId || ""))
    ));

  const byCommunity = new Map();
  publishedCommunities.forEach((row) => {
    const current = byCommunity.get(row.communityId);
    if (!current || row.role === "RATING_PRIMARY") byCommunity.set(row.communityId, row);
  });
  const uniqueCommunities = [...byCommunity.values()];
  const primary = uniqueCommunities.filter((row) => row.role === "RATING_PRIMARY");
  const ratingCommunityId = primary.length === 1
    ? primary[0].communityId
    : (primary.length === 0 && uniqueCommunities.length === 1 ? uniqueCommunities[0].communityId : null);
  const ratingCommunityStatus = ratingCommunityId
    ? "RESOLVED"
    : uniqueCommunities.length === 0
      ? "NOT_PUBLISHED"
      : "AMBIGUOUS";

  return {
    tournamentId,
    publishedCommunities: uniqueCommunities,
    ratingCommunityId,
    ratingCommunityStatus,
  };
}

function playerIdentity(record) {
  if (!isObject(record)) return null;
  const explicit = firstString(record, [["clientId"], ["playerId"], ["userId"], ["uuid"]]);
  if (explicit) return explicit;
  const id = toStringOrNull(record.id);
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

function playerName(record) {
  return firstString(record, [["name"], ["playerName"], ["displayName"]]) || "Игрок";
}

function playerPhone(record) {
  return normalizePhone(firstString(record, [["phoneNorm"], ["phone"], ["phoneNumber"], ["mobile"]]));
}

function memberHasIdentity(member, playerId, phoneNorm) {
  if (!isObject(member)) return false;
  const ids = unique([member.id, member.clientId, member.playerId, member.userId, member.uuid].map(toStringOrNull));
  const memberPhone = normalizePhone(member.phoneNorm ?? member.phone ?? member.phoneNumber ?? member.mobile);
  return ids.includes(playerId) || Boolean(phoneNorm && memberPhone && phoneNorm === memberPhone);
}

function hasPhoneOnlyIdentity(member) {
  if (!isObject(member)) return false;
  const hasId = unique([member.id, member.clientId, member.playerId, member.userId, member.uuid].map(toStringOrNull)).length > 0;
  return !hasId && Boolean(normalizePhone(member.phoneNorm ?? member.phone ?? member.phoneNumber ?? member.mobile));
}

function isCancelledParticipant(record) {
  const status = String(record?.status ?? record?.state ?? "").trim().toLowerCase();
  return record?.isCancelled === true
    || record?.cancelled === true
    || record?.canceled === true
    || ["cancelled", "canceled", "cancel"].includes(status);
}

function resolvePlayers(tournament) {
  const capacity = Number(
    tournament?.maxParticipants
    ?? tournament?.maxClientsCount
    ?? tournament?.params?.maxParticipants
    ?? tournament?.params?.maxClientsCount,
  );
  const skipped = [];
  const quarantined = [];
  const excludedPlayerIds = new Set();
  const participants = asArray(tournament?.participants).filter((record, rosterIndex) => {
    const playerId = playerIdentity(record);
    const exclude = (reason, target) => {
      if (playerId) excludedPlayerIds.add(playerId);
      target.push({ playerId, rosterIndex, reason });
      return false;
    };
    if (isCancelledParticipant(record)) return exclude("CANCELLED_ROSTER_ROW", skipped);
    if (record?.isCancelled !== false) return exclude("ACTIVE_STATUS_NOT_PROVEN", quarantined);
    if (!Number.isFinite(capacity) || capacity <= 0) return exclude("CAPACITY_NOT_PROVEN", quarantined);
    const spot = Number(record?.spot ?? record?.placeNumber);
    if (!Number.isFinite(spot) || spot <= 0) return exclude("ACTIVE_SPOT_NOT_PROVEN", quarantined);
    if (spot > capacity) return exclude("WAITLIST_OUTSIDE_CAPACITY", skipped);
    return true;
  });
  const standings = isTournamentFinalized(tournament)
    ? asArray(tournament?.standings).filter((record) => {
      const playerId = playerIdentity(record);
      return !playerId || !excludedPlayerIds.has(playerId);
    })
    : [];
  const candidates = [...participants, ...standings];
  const players = new Map();
  candidates.forEach((record, index) => {
    const playerId = playerIdentity(record);
    if (!playerId) return;
    const current = players.get(playerId);
    const phoneNorm = playerPhone(record) || current?.phoneNorm || null;
    players.set(playerId, {
      playerId,
      phoneNorm,
      playerName: playerName(record) || current?.playerName || "Игрок",
      sourceIndex: index,
    });
  });
  return { players: [...players.values()], skipped, quarantined };
}

function resolveCommunityRatingProgram(community) {
  const program = isObject(community?.ratingProgram)
    ? community.ratingProgram
    : (isObject(community?.metadata?.ratingProgram) ? community.metadata.ratingProgram : null);
  return {
    programKey: toStringOrNull(program?.programKey ?? program?.key),
    stationId: toStringOrNull(program?.stationId),
    autoEnrollmentEnabled: program?.autoEnrollmentEnabled === true,
    validatedPublications: asArray(program?.validatedPublications),
  };
}

function resolvePublicationServerApproval(ratingProgram, publication, tournamentId, stationId) {
  const publicationId = toStringOrNull(publication?.id ?? publication?._id);
  if (!publicationId) return null;
  return ratingProgram.validatedPublications.find((row) => (
    isObject(row)
    && String(row.status || "").trim().toUpperCase() === "VALIDATED"
    && toStringOrNull(row.publicationId) === publicationId
    && toStringOrNull(row.tournamentId) === tournamentId
    && toStringOrNull(row.stationId) === stationId
  )) || null;
}

export function resolveTimeForFriendsProviderRosterRequest({ tournament, feedPosts, communities }) {
  const context = resolveTournamentCommunityContext({ tournament, feedPosts });
  const tournamentId = context.tournamentId;
  if (!tournamentId || !UUID_RE.test(tournamentId) || !context.ratingCommunityId) return null;
  const source = String(tournament?.source || tournament?.tournamentSource || "").trim().toUpperCase();
  const hasProviderAlias = Boolean(
    toStringOrNull(tournament?.exerciseId) || toStringOrNull(tournament?.sourceTournamentId),
  );
  if (source !== "CUSTOM" && !hasProviderAlias) return null;
  if (asArray(tournament?.participants).length > 0) return null;
  const community = asArray(communities).find((row) => (
    !isArchived(row) && toStringOrNull(row.id ?? row.communityId) === context.ratingCommunityId
  ));
  if (!community) return null;
  const ratingProgram = resolveCommunityRatingProgram(community);
  if (ratingProgram.programKey !== "TIME_FOR_FRIENDS" || !ratingProgram.autoEnrollmentEnabled) return null;
  if (!ratingProgram.stationId) return null;
  const publication = context.publishedCommunities.find((row) => row.communityId === context.ratingCommunityId);
  const sourcePublication = asArray(feedPosts).find((row) => (
    publicationMatchesTournament(row, tournamentId)
    && toStringOrNull(row.communityId) === context.ratingCommunityId
    && (!publication?.publicationId || toStringOrNull(row.id ?? row._id) === publication.publicationId)
  ));
  const publicationId = toStringOrNull(sourcePublication?.id ?? sourcePublication?._id);
  if (!publicationId) return null;
  const linkedPublications = asArray(feedPosts).filter((row) => publicationMatchesTournament(row, tournamentId));
  const persistedDirectionIds = unique([
    ...collectDirectionIds(tournament),
    ...linkedPublications.flatMap(collectDirectionIds),
  ]);
  if (persistedDirectionIds.some((directionId) => directionId !== TIME_FOR_FRIENDS_DIRECTION_ID)) return null;
  const persistedStationIds = unique([
    ...collectStationIds(tournament),
    ...linkedPublications.flatMap(collectStationIds),
  ]);
  if (persistedStationIds.some((stationId) => stationId !== ratingProgram.stationId)) return null;
  const approval = ratingProgram.validatedPublications.find((row) => (
    isObject(row)
    && String(row.status || "").trim().toUpperCase() === "VALIDATED"
    && toStringOrNull(row.publicationId) === publicationId
    && toStringOrNull(row.tournamentId) === tournamentId
    && toStringOrNull(row.stationId) === ratingProgram.stationId
  ));
  return approval ? { tournamentId, communityId: context.ratingCommunityId, publicationId } : null;
}

export function planTimeForFriendsAutoEnrollment({ tournament, feedPosts, communities, providerEnrollment = null }) {
  const context = resolveTournamentCommunityContext({ tournament, feedPosts });
  const tournamentId = context.tournamentId;
  const skipped = [];
  const quarantined = [];
  if (!tournamentId) {
    quarantined.push({ reason: context.ratingCommunityStatus === "TOURNAMENT_RELATION_AMBIGUOUS"
      ? "TOURNAMENT_RELATION_AMBIGUOUS"
      : "TOURNAMENT_ID_MISSING" });
    return { context, operations: [], skipped, quarantined };
  }

  const linkedPosts = asArray(feedPosts).filter((post) => publicationMatchesTournament(post, tournamentId));
  if (providerEnrollment && toStringOrNull(providerEnrollment.exerciseId) !== tournamentId) {
    quarantined.push({ tournamentId, reason: "PROVIDER_EXERCISE_ID_CONFLICT" });
    return { context, operations: [], skipped, quarantined };
  }
  const directionIds = unique([
    ...collectDirectionIds(tournament),
    ...linkedPosts.flatMap(collectDirectionIds),
    ...(providerEnrollment ? [toStringOrNull(providerEnrollment.directionId)] : []),
  ]);
  if (directionIds.length !== 1) {
    quarantined.push({ tournamentId, reason: directionIds.length === 0 ? "DIRECTION_ID_NOT_PROVEN" : "DIRECTION_ID_CONFLICT" });
    return { context, operations: [], skipped, quarantined };
  }
  if (directionIds[0] !== TIME_FOR_FRIENDS_DIRECTION_ID) {
    skipped.push({ tournamentId, reason: "NOT_TIME_FOR_FRIENDS" });
    return { context, operations: [], skipped, quarantined };
  }
  if (!context.ratingCommunityId) {
    quarantined.push({ tournamentId, reason: context.ratingCommunityStatus === "NOT_PUBLISHED"
      ? "ELIGIBLE_PUBLICATION_NOT_FOUND"
      : "ELIGIBLE_PUBLICATION_AMBIGUOUS" });
    return { context, operations: [], skipped, quarantined };
  }

  const stationIds = unique([
    ...collectStationIds(tournament),
    ...linkedPosts.flatMap(collectStationIds),
    ...(providerEnrollment ? [toStringOrNull(providerEnrollment.stationId)] : []),
  ]);
  if (stationIds.length !== 1) {
    quarantined.push({ tournamentId, reason: stationIds.length === 0 ? "STATION_ID_MISSING" : "STATION_ID_CONFLICT" });
    return { context, operations: [], skipped, quarantined };
  }

  const community = asArray(communities).find((row) => (
    !isArchived(row) && toStringOrNull(row.id ?? row.communityId) === context.ratingCommunityId
  ));
  if (!community) {
    quarantined.push({ tournamentId, communityId: context.ratingCommunityId, reason: "COMMUNITY_NOT_ACTIVE" });
    return { context, operations: [], skipped, quarantined };
  }
  const publication = context.publishedCommunities.find((row) => row.communityId === context.ratingCommunityId);
  const sourcePublication = linkedPosts.find((row) => (
    toStringOrNull(row.communityId) === context.ratingCommunityId
    && (!publication?.publicationId || toStringOrNull(row.id ?? row._id) === publication.publicationId)
  ));
  const ratingProgram = resolveCommunityRatingProgram(community);
  if (ratingProgram.programKey !== "TIME_FOR_FRIENDS" || !ratingProgram.autoEnrollmentEnabled) {
    quarantined.push({ tournamentId, communityId: context.ratingCommunityId, reason: "COMMUNITY_RATING_PROGRAM_NOT_APPROVED" });
    return { context, operations: [], skipped, quarantined };
  }
  const serverApproval = sourcePublication
    ? resolvePublicationServerApproval(ratingProgram, sourcePublication, tournamentId, stationIds[0])
    : null;
  const publicationStationId = publication?.stationId || toStringOrNull(serverApproval?.stationId);
  if (!publicationStationId || !ratingProgram.stationId) {
    quarantined.push({ tournamentId, communityId: context.ratingCommunityId, reason: "STATION_ID_NOT_PROVEN" });
    return { context, operations: [], skipped, quarantined };
  }
  if (publicationStationId !== stationIds[0] || ratingProgram.stationId !== stationIds[0]) {
    quarantined.push({ tournamentId, communityId: context.ratingCommunityId, reason: "STATION_ID_CONFLICT" });
    return { context, operations: [], skipped, quarantined };
  }
  if (!sourcePublication || !serverApproval) {
    quarantined.push({ tournamentId, communityId: context.ratingCommunityId, reason: "PUBLICATION_SERVER_APPROVAL_NOT_PROVEN" });
    return { context, operations: [], skipped, quarantined };
  }

  const operations = [];
  const playerResolution = resolvePlayers(providerEnrollment
    ? {
      participants: providerEnrollment.participants,
      maxParticipants: providerEnrollment.maxParticipants,
    }
    : tournament);
  playerResolution.skipped.forEach((row) => skipped.push({ tournamentId, communityId: context.ratingCommunityId, ...row }));
  playerResolution.quarantined.forEach((row) => quarantined.push({ tournamentId, communityId: context.ratingCommunityId, ...row }));
  playerResolution.players.forEach((player) => {
    if (!player.phoneNorm && [...asArray(community.members), ...asArray(community.bannedMembers)].some(hasPhoneOnlyIdentity)) {
      quarantined.push({ tournamentId, communityId: context.ratingCommunityId, playerId: player.playerId, reason: "COMMUNITY_LEGACY_IDENTITY_UNRESOLVED" });
      return;
    }
    if (asArray(community.bannedMembers).some((member) => memberHasIdentity(member, player.playerId, player.phoneNorm))) {
      quarantined.push({ tournamentId, communityId: context.ratingCommunityId, playerId: player.playerId, reason: "PLAYER_BANNED" });
      return;
    }
    if (asArray(community.members).some((member) => memberHasIdentity(member, player.playerId, player.phoneNorm))) {
      skipped.push({ tournamentId, communityId: context.ratingCommunityId, playerId: player.playerId, reason: "ALREADY_MEMBER" });
      return;
    }
    const operationId = crypto.createHash("sha256")
      .update(`${TOURNAMENT_COMMUNITY_ENROLLMENT_VERSION}|${tournamentId}|${context.ratingCommunityId}|${player.playerId}`)
      .digest("hex");
    operations.push({
      operationId,
      tournamentId,
      tournamentIds: [tournamentId],
      communityId: context.ratingCommunityId,
      stationId: stationIds[0],
      playerId: player.playerId,
      phoneNorm: player.phoneNorm,
      playerName: player.playerName,
      joinSourceType: "TIME_FOR_FRIENDS_TOURNAMENT_AUTO_ENROLLMENT",
      joinSourceVersion: TOURNAMENT_COMMUNITY_ENROLLMENT_VERSION,
    });
  });
  return { context, operations, skipped, quarantined };
}

export function buildTimeForFriendsAutoEnrollmentMutation(operation, nowIso) {
  return buildTimeForFriendsAtomicMembershipMutation(operation, nowIso);
}

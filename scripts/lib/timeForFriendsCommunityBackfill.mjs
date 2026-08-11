import crypto from "node:crypto";
import {
  isTournamentFinalized,
} from "./tournamentFinalization.mjs";

export const TIME_FOR_FRIENDS_DIRECTION_ID = "5278";
export const TIME_FOR_FRIENDS_BACKFILL_VERSION = "time-for-friends-community-backfill-v1";

const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toStringOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const unique = (values) => Array.from(new Set(values.filter(Boolean)));

function nested(record, path) {
  let current = record;
  for (const part of path) {
    if (!isObject(current)) return null;
    current = current[part];
  }
  return current;
}

function collectExactValues(record, paths) {
  return unique(paths.map((path) => toStringOrNull(nested(record, path))));
}

function normalizeKind(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function diagnosticCode(value, fallback = null) {
  const normalized = toStringOrNull(value);
  if (!normalized) return fallback;
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : "REDACTED_DIAGNOSTIC";
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function isArchived(record) {
  return record?.archived === true || normalizeStatus(record?.status) === "archived";
}

const TOURNAMENT_ID_PATHS = [
  ["tournamentId"],
  ["id"],
  ["exerciseId"],
  ["sourceTournamentId"],
  ["details", "tournamentId"],
  ["details", "exerciseId"],
  ["details", "publicTournament", "id"],
  ["details", "publicTournament", "exerciseId"],
  ["details", "sourceTournamentSnapshot", "id"],
  ["details", "sourceTournamentSnapshot", "exerciseId"],
  ["publicTournament", "id"],
  ["publicTournament", "exerciseId"],
  ["sourceTournamentSnapshot", "id"],
  ["sourceTournamentSnapshot", "exerciseId"],
];

const DIRECTION_ID_PATHS = [
  ["direction", "id"],
  ["params", "direction", "id"],
  ["params", "directionId"],
  ["details", "direction", "id"],
  ["details", "publicTournament", "direction", "id"],
  ["details", "sourceTournamentSnapshot", "direction", "id"],
  ["publicTournament", "direction", "id"],
  ["sourceTournamentSnapshot", "direction", "id"],
];

const STATION_ID_PATHS = [
  ["stationId"],
  ["studioId"],
  ["params", "stationId"],
  ["params", "studioId"],
  ["params", "studio", "id"],
  ["details", "stationId"],
  ["details", "studioId"],
  ["details", "publicTournament", "studio", "id"],
  ["details", "sourceTournamentSnapshot", "studio", "id"],
  ["publicTournament", "studio", "id"],
  ["sourceTournamentSnapshot", "studio", "id"],
];

export function collectTournamentIds(record) {
  return collectExactValues(record, TOURNAMENT_ID_PATHS);
}

export function collectPublicationTournamentIds(record) {
  const prioritizedPaths = [
    ["relatedTournamentId"],
    ["tournamentId"],
    ["details", "relatedTournamentId"],
    ["details", "details", "relatedTournamentId"],
    ["details", "publicTournament", "exerciseId"],
    ["details", "publicTournament", "sourceTournamentId"],
    ["details", "publicTournament", "tournamentId"],
    ["details", "publicTournament", "id"],
    ["details", "sourceTournamentSnapshot", "exerciseId"],
    ["details", "sourceTournamentSnapshot", "sourceTournamentId"],
    ["details", "sourceTournamentSnapshot", "tournamentId"],
    ["details", "sourceTournamentSnapshot", "id"],
  ];
  for (const path of prioritizedPaths) {
    const candidate = toStringOrNull(nested(record, path));
    if (candidate) return [candidate];
  }
  return [];
}

export function collectDirectionIds(record) {
  return collectExactValues(record, DIRECTION_ID_PATHS);
}

export function collectStationIds(record) {
  return collectExactValues(record, STATION_ID_PATHS);
}

function normalizePlayerId(value) {
  const id = toStringOrNull(value);
  if (!id) return null;
  if (/^(manual[-_:]|participant[-_:]|p-\d+$|unknown[-_:])/i.test(id)) return null;
  if (/^\+?\d{10,15}$/.test(id.replace(/[\s()-]/g, ""))) return null;
  return id;
}

function normalizeUuidPlayerId(value) {
  const id = normalizePlayerId(value);
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

function playerIdentity(record) {
  if (!isObject(record)) return null;
  return normalizePlayerId(record.clientId ?? record.playerId ?? record.userId)
    || normalizeUuidPlayerId(record.id);
}

function playerName(record) {
  if (!isObject(record)) return "Игрок";
  return toStringOrNull(record.name)
    || toStringOrNull(record.playerName)
    || toStringOrNull([record.firstName, record.lastName].filter(Boolean).join(" "))
    || "Игрок";
}

function playerPhone(record) {
  if (!isObject(record)) return null;
  return normalizePhone(record.phoneNorm ?? record.phone ?? record.phoneNumber ?? record.mobile);
}

function resolveVivaRosterPlayers(roster) {
  const providerStatus = diagnosticCode(roster?.sourceStatus, "MISSING");
  const providerError = diagnosticCode(roster?.error);
  const metadataStatus = diagnosticCode(roster?.metadataStatus);
  const details = {
    providerStatus,
    ...(providerError ? { providerError } : {}),
    ...(metadataStatus ? { metadataStatus } : {}),
  };
  if (!isObject(roster) || providerStatus !== "PROVEN_ACTIVE") {
    return {
      players: null,
      error: "PARTICIPATION_SOURCE_NOT_PROVEN",
      errorDetails: details,
      skipReason: null,
      quarantined: [],
      skipped: [],
    };
  }
  if (roster.exerciseEnded === false) {
    return {
      players: null,
      error: null,
      errorDetails: details,
      skipReason: "EXERCISE_NOT_ENDED",
      quarantined: [],
      skipped: [],
    };
  }
  if (roster.exerciseEnded !== true) {
    return {
      players: null,
      error: "EXERCISE_END_NOT_PROVEN",
      errorDetails: details,
      skipReason: null,
      quarantined: [],
      skipped: [],
    };
  }
  const capacity = Number(roster.capacity ?? roster.maxPlayers ?? roster.maxClientsCount);
  if (!Number.isInteger(capacity) || capacity <= 0) {
    return {
      players: null,
      error: "CAPACITY_NOT_PROVEN",
      errorDetails: details,
      skipReason: null,
      quarantined: [],
      skipped: [],
    };
  }
  const participants = asArray(roster.participants);
  if (participants.length === 0) {
    return {
      players: null,
      error: null,
      errorDetails: details,
      skipReason: "NO_ACTIVE_PARTICIPANTS",
      quarantined: [],
      skipped: [],
    };
  }
  const players = [];
  const quarantinedRows = [];
  const skippedRows = [];
  participants.forEach((row, index) => {
    const status = normalizeStatus(row?.status ?? row?.state);
    if (row?.isCancelled === true || row?.cancelled === true || row?.canceled === true
      || ["cancelled", "canceled", "cancel"].includes(status)) {
      skippedRows.push({ rosterIndex: index, reason: "CANCELLED_ROSTER_ROW" });
      return;
    }
    if (row?.isCancelled !== false) {
      quarantinedRows.push({ rosterIndex: index, reason: "ROSTER_ACTIVE_STATUS_NOT_PROVEN" });
      return;
    }
    const playerId = playerIdentity(row?.client || row);
    if (!playerId) {
      quarantinedRows.push({ rosterIndex: index, reason: "PLAYER_CLIENT_ID_MISSING" });
      return;
    }
    const spot = Number(row?.spot);
    if (!Number.isInteger(spot) || spot < 1) {
      quarantinedRows.push({ rosterIndex: index, reason: "ACTIVE_SPOT_NOT_PROVEN" });
      return;
    }
    if (spot > capacity) {
      skippedRows.push({ rosterIndex: index, spot, capacity, reason: "WAITLIST_OUTSIDE_CAPACITY" });
      return;
    }
    players.push({
      index,
      playerId,
      phoneNorm: playerPhone(row.client || row),
      name: playerName(row.client || row),
    });
  });
  return {
    players,
    error: null,
    errorDetails: details,
    skipReason: players.length === 0 && quarantinedRows.length === 0
      ? "NO_ACTIVE_PARTICIPANTS"
      : null,
    quarantined: quarantinedRows,
    skipped: skippedRows,
  };
}

function memberHasPlayerIdentity(member, playerId, phoneNorm) {
  if (!isObject(member)) return false;
  const idMatch = [member.id, member.clientId, member.playerId, member.userId]
    .map(toStringOrNull)
    .some((candidate) => candidate === playerId);
  const phoneMatch = phoneNorm && [member.phoneNorm, member.phone, member.phoneNumber, member.mobile]
    .map(normalizePhone)
    .some((candidate) => candidate === phoneNorm);
  return Boolean(idMatch || phoneMatch);
}

function hasPhoneOnlyIdentity(member) {
  if (!isObject(member)) return false;
  const hasId = [member.id, member.clientId, member.playerId, member.userId]
    .map(toStringOrNull)
    .some(Boolean);
  return !hasId && Boolean(playerPhone(member));
}

function resolveStandingPlayers(tournament) {
  const participants = asArray(tournament?.participants).filter(isObject);
  const participantById = new Map();
  participants.forEach((participant) => {
    const id = playerIdentity(participant);
    if (id) participantById.set(id, participant);
    const rawId = toStringOrNull(participant.id);
    if (rawId) participantById.set(rawId, participant);
  });

  return asArray(tournament?.standings).map((standing, index) => {
    if (!isObject(standing)) return { index, playerId: null, name: "Игрок" };
    const standingId = toStringOrNull(standing.id ?? standing.playerId ?? standing.clientId ?? standing.userId);
    const participant = standingId ? participantById.get(standingId) : null;
    return {
      index,
      playerId: normalizePlayerId(standing.clientId ?? standing.playerId ?? standing.userId)
        || playerIdentity(participant)
        || normalizeUuidPlayerId(standing.id),
      phoneNorm: playerPhone(participant) || playerPhone(standing),
      name: playerName(participant || standing),
    };
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sortCanonicalRows(values) {
  return asArray(values).map(canonicalize).sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
}

export function hashBackfillPlan(plan) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(plan)))
    .digest("hex");
}

export function redactPlayerId(playerId) {
  return `player:${crypto.createHash("sha256").update(String(playerId)).digest("hex").slice(0, 16)}`;
}

export function shouldTreatExistingMembershipAsApplied(previousLedgerStatus) {
  return ["APPLIED", "APPLIED_IDEMPOTENT"].includes(toStringOrNull(previousLedgerStatus));
}

export function classifyExistingMembershipAfterPreviousLedger(previousLedgerStatus, inspection) {
  const previous = toStringOrNull(previousLedgerStatus);
  const verified = inspection?.identityCount === 1 && inspection?.memberCountConsistent === true;
  const backfillOwned = verified && inspection?.backfillProvenance === true;
  if (shouldTreatExistingMembershipAsApplied(previous)) {
    return backfillOwned ? "APPLIED_IDEMPOTENT" : "READBACK_FAILED";
  }
  if (previous && previous !== "ALREADY_MEMBER") {
    if (backfillOwned) return "RECOVERED_APPLIED";
    return verified ? "CONCURRENT_ALREADY_MEMBER" : "READBACK_FAILED";
  }
  return "ALREADY_MEMBER";
}

export function validateBackfillScope(scope) {
  if (!isObject(scope)) throw new Error("Scope manifest must be an object");
  if (String(scope.directionId) !== TIME_FOR_FRIENDS_DIRECTION_ID) {
    throw new Error(`Scope directionId must be ${TIME_FOR_FRIENDS_DIRECTION_ID}`);
  }
  const communities = asArray(scope.communities).map((row, index) => {
    const communityId = toStringOrNull(row?.communityId);
    const stationId = toStringOrNull(row?.stationId);
    if (!communityId || !stationId) throw new Error(`Scope communities[${index}] requires exact communityId and stationId`);
    return { communityId, stationId };
  });
  if (communities.length === 0) throw new Error("Scope requires at least one approved community");
  if (new Set(communities.map((row) => row.communityId)).size !== communities.length) {
    throw new Error("Scope contains duplicate communityId values");
  }
  const approvedByCommunityId = new Map(communities.map((row) => [row.communityId, row]));
  const tournamentMappings = asArray(scope.tournamentMappings).map((row, index) => {
    const tournamentId = toStringOrNull(row?.tournamentId);
    const communityId = toStringOrNull(row?.communityId);
    const stationId = toStringOrNull(row?.stationId);
    if (!tournamentId || !communityId || !stationId) {
      throw new Error(`Scope tournamentMappings[${index}] requires exact tournamentId, communityId and stationId`);
    }
    const approved = approvedByCommunityId.get(communityId);
    if (!approved || approved.stationId !== stationId) {
      throw new Error(`Scope tournamentMappings[${index}] must reference an approved exact community/station pair`);
    }
    return { tournamentId, communityId, stationId };
  });
  if (new Set(tournamentMappings.map((row) => row.tournamentId)).size !== tournamentMappings.length) {
    throw new Error("Scope contains duplicate tournamentMappings tournamentId values");
  }
  return {
    version: toStringOrNull(scope.version) || "time-for-friends-scope-v1",
    directionId: TIME_FOR_FRIENDS_DIRECTION_ID,
    communities: communities.sort((left, right) => left.communityId.localeCompare(right.communityId)),
    tournamentMappings: tournamentMappings.sort((left, right) => left.tournamentId.localeCompare(right.tournamentId)),
  };
}

function quarantine(tournamentId, reason, details = {}) {
  return { tournamentId, reason, ...details };
}

export function buildTimeForFriendsCommunityBackfillPlan({
  scope: rawScope,
  tournaments,
  feedPosts,
  communities,
  participantRosters = {},
  inventoryCoverage = null,
}) {
  const scope = validateBackfillScope(rawScope);
  const scopeByCommunityId = new Map(scope.communities.map((row) => [row.communityId, row]));
  const manualMappingByTournamentId = new Map(scope.tournamentMappings.map((row) => [row.tournamentId, row]));
  const communityById = new Map(asArray(communities).filter(isObject).map((row) => [toStringOrNull(row.id ?? row.communityId), row]));
  const historicalPublications = asArray(feedPosts).filter((post) => (
    isObject(post)
    && normalizeKind(post.kind ?? post.type) === "TOURNAMENT"
    && scopeByCommunityId.has(toStringOrNull(post.communityId))
  ));

  const publicationsByTournamentId = new Map();
  historicalPublications.forEach((post) => {
    collectPublicationTournamentIds(post).forEach((tournamentId) => {
      const bucket = publicationsByTournamentId.get(tournamentId) || [];
      bucket.push(post);
      publicationsByTournamentId.set(tournamentId, bucket);
    });
  });
  const operationsByMembership = new Map();
  const quarantined = [];
  const skipped = [];
  const providerStatusCounts = {};
  let matchedTournaments = 0;

  const tournamentRecords = [...asArray(tournaments).filter(isObject)];
  const knownTournamentIds = new Set(tournamentRecords.flatMap(collectTournamentIds));
  historicalPublications.forEach((post) => {
    collectPublicationTournamentIds(post).forEach((tournamentId) => {
      if (knownTournamentIds.has(tournamentId)) return;
      tournamentRecords.push({
        tournamentId,
        _participantSourceOnly: true,
      });
      knownTournamentIds.add(tournamentId);
    });
  });
  Object.keys(participantRosters).sort().forEach((tournamentId) => {
    if (knownTournamentIds.has(tournamentId)) return;
    tournamentRecords.push({ tournamentId, _participantSourceOnly: true });
    knownTournamentIds.add(tournamentId);
  });

  tournamentRecords.forEach((tournament) => {
    const tournamentIds = collectTournamentIds(tournament);
    const tournamentId = tournamentIds[0] || "unknown";
    const linkedPosts = unique(tournamentIds.flatMap((id) => publicationsByTournamentId.get(id) || []));
    const participantRoster = participantRosters[tournamentId];
    if (participantRoster) {
      const providerStatus = diagnosticCode(participantRoster.sourceStatus, "MISSING");
      providerStatusCounts[providerStatus] = (providerStatusCounts[providerStatus] || 0) + 1;
    }
    const directionIds = unique([
      ...collectDirectionIds(tournament),
      ...linkedPosts.flatMap(collectDirectionIds),
      toStringOrNull(participantRoster?.directionId),
    ]);
    matchedTournaments += 1;
    if (directionIds.length > 1) {
      quarantined.push(quarantine(tournamentId, "DIRECTION_ID_CONFLICT", { directionIds: directionIds.sort() }));
      return;
    }
    if (directionIds.length === 1 && directionIds[0] !== TIME_FOR_FRIENDS_DIRECTION_ID) {
      skipped.push({
        tournamentId,
        reason: "NOT_TIME_FOR_FRIENDS",
        directionId: directionIds[0],
        providerStatus: diagnosticCode(participantRoster?.sourceStatus, "MISSING"),
        recordSource: tournament._participantSourceOnly === true ? "PROVIDER" : "LOCAL_TOURNAMENT",
      });
      return;
    }
    if (directionIds.length === 0) {
      quarantined.push(quarantine(tournamentId, tournament._participantSourceOnly === true
        ? "PROVIDER_DIRECTION_ID_NOT_PROVEN"
        : "DIRECTION_ID_NOT_PROVEN", {
        providerStatus: diagnosticCode(participantRoster?.sourceStatus, "MISSING"),
        metadataStatus: diagnosticCode(participantRoster?.metadataStatus, "MISSING"),
      }));
      return;
    }
    if (tournament._participantSourceOnly === true && !directionIds.includes(TIME_FOR_FRIENDS_DIRECTION_ID)) {
      quarantined.push(quarantine(tournamentId, "PROVIDER_DIRECTION_ID_NOT_PROVEN", {
        providerStatus: diagnosticCode(participantRoster?.sourceStatus, "MISSING"),
        metadataStatus: diagnosticCode(participantRoster?.metadataStatus, "MISSING"),
        ...(diagnosticCode(participantRoster?.error)
          ? { providerError: diagnosticCode(participantRoster.error) }
          : {}),
      }));
      return;
    }
    if (tournament._participantSourceOnly === true
      && (String(participantRoster?.directionId) !== TIME_FOR_FRIENDS_DIRECTION_ID
        || diagnosticCode(participantRoster?.metadataStatus, "MISSING") !== "OK")) {
      quarantined.push(quarantine(tournamentId, "PROVIDER_DIRECTION_ID_NOT_PROVEN", {
        providerStatus: diagnosticCode(participantRoster?.sourceStatus, "MISSING"),
        metadataStatus: diagnosticCode(participantRoster?.metadataStatus, "MISSING"),
      }));
      return;
    }
    const hasFinalStandings = isTournamentFinalized(tournament)
      && asArray(tournament.standings).length > 0;
    const vivaRosterResolution = hasFinalStandings
      ? {
        players: null,
        error: null,
        errorDetails: {},
        skipReason: null,
        quarantined: [],
        skipped: [],
      }
      : resolveVivaRosterPlayers(participantRoster);
    vivaRosterResolution.quarantined.forEach((row) => {
      quarantined.push(quarantine(tournamentId, row.reason, {
        rosterIndex: row.rosterIndex,
        ...vivaRosterResolution.errorDetails,
      }));
    });
    vivaRosterResolution.skipped.forEach((row) => {
      skipped.push({
        tournamentId,
        ...row,
        providerStatus: vivaRosterResolution.errorDetails.providerStatus,
      });
    });
    if (!hasFinalStandings && vivaRosterResolution.skipReason) {
      skipped.push({
        tournamentId,
        reason: vivaRosterResolution.skipReason,
        ...vivaRosterResolution.errorDetails,
      });
      return;
    }
    if (!hasFinalStandings && !vivaRosterResolution.players) {
      quarantined.push(quarantine(tournamentId, vivaRosterResolution.error || "PARTICIPATION_SOURCE_NOT_PROVEN", {
        localTournamentFound: tournament._participantSourceOnly !== true,
        ...vivaRosterResolution.errorDetails,
      }));
      return;
    }

    const stationIds = unique([
      ...collectStationIds(tournament),
      ...linkedPosts.flatMap(collectStationIds),
      toStringOrNull(participantRoster?.stationId),
    ]);
    if (stationIds.length !== 1) {
      quarantined.push(quarantine(tournamentId, stationIds.length === 0 ? "STATION_ID_MISSING" : "STATION_ID_CONFLICT", {
        stationIds: stationIds.sort(),
      }));
      return;
    }

    let eligiblePublications = linkedPosts.filter((post) => {
      const communityId = toStringOrNull(post.communityId);
      const approved = scopeByCommunityId.get(communityId);
      const community = communityById.get(communityId);
      return approved?.stationId === stationIds[0] && community && !isArchived(community);
    });
    let eligibleCommunityIds = unique(eligiblePublications.map((post) => toStringOrNull(post.communityId)));
    const manualMapping = manualMappingByTournamentId.get(tournamentId);
    if (manualMapping) {
      if (manualMapping.stationId !== stationIds[0]) {
        quarantined.push(quarantine(tournamentId, "MANUAL_MAPPING_STATION_CONFLICT", {
          mappedStationId: manualMapping.stationId,
          sourceStationId: stationIds[0],
        }));
        return;
      }
      if (eligibleCommunityIds.length > 0 && !eligibleCommunityIds.includes(manualMapping.communityId)) {
        quarantined.push(quarantine(tournamentId, "MANUAL_MAPPING_PUBLICATION_CONFLICT", {
          mappedCommunityId: manualMapping.communityId,
          publicationCommunityIds: eligibleCommunityIds.sort(),
        }));
        return;
      }
      const mappedCommunity = communityById.get(manualMapping.communityId);
      if (!mappedCommunity || isArchived(mappedCommunity)) {
        quarantined.push(quarantine(tournamentId, "MANUAL_MAPPING_COMMUNITY_NOT_ACTIVE", {
          mappedCommunityId: manualMapping.communityId,
        }));
        return;
      }
      eligibleCommunityIds = [manualMapping.communityId];
      eligiblePublications = eligiblePublications.filter((post) => (
        toStringOrNull(post.communityId) === manualMapping.communityId
      ));
    }
    if (eligibleCommunityIds.length !== 1) {
      quarantined.push(quarantine(tournamentId, eligibleCommunityIds.length === 0
        ? "ELIGIBLE_PUBLICATION_NOT_FOUND"
        : "ELIGIBLE_PUBLICATION_AMBIGUOUS", {
        communityIds: eligibleCommunityIds.sort(),
        stationId: stationIds[0],
      }));
      return;
    }

    const communityId = eligibleCommunityIds[0];
    const community = communityById.get(communityId);
    const publicationIds = unique(eligiblePublications.map((post) => toStringOrNull(post.id ?? post._id)));
    const ratingEligible = hasFinalStandings
      && eligiblePublications.some((post) => !isArchived(post));
    const resolvedPlayers = hasFinalStandings
      ? resolveStandingPlayers(tournament)
      : vivaRosterResolution.players;
    resolvedPlayers.forEach((player) => {
      if (!player.playerId) {
        quarantined.push(quarantine(tournamentId, "PLAYER_CLIENT_ID_MISSING", { standingIndex: player.index }));
        return;
      }
      const legacyPhoneIdentityUnresolved = !player.phoneNorm
        && [...asArray(community.members), ...asArray(community.bannedMembers)]
          .some(hasPhoneOnlyIdentity);
      if (legacyPhoneIdentityUnresolved) {
        quarantined.push(quarantine(tournamentId, "COMMUNITY_LEGACY_IDENTITY_UNRESOLVED", {
          playerId: player.playerId,
          communityId,
        }));
        return;
      }
      if (asArray(community.bannedMembers)
        .some((member) => memberHasPlayerIdentity(member, player.playerId, player.phoneNorm))) {
        quarantined.push(quarantine(tournamentId, "PLAYER_BANNED", { playerId: player.playerId, communityId }));
        return;
      }
      if (asArray(community.members)
        .some((member) => memberHasPlayerIdentity(member, player.playerId, player.phoneNorm))) {
        skipped.push({ tournamentId, communityId, playerId: player.playerId, reason: "ALREADY_MEMBER" });
        return;
      }

      const membershipKey = `${communityId}|${player.playerId}`;
      const current = operationsByMembership.get(membershipKey) || {
        operationId: crypto.createHash("sha256")
          .update(`${TIME_FOR_FRIENDS_BACKFILL_VERSION}|${membershipKey}`)
          .digest("hex"),
        communityId,
        stationId: stationIds[0],
        playerId: player.playerId,
        phoneNorm: player.phoneNorm,
        playerName: player.name,
        tournamentIds: [],
        publicationIds: [],
        ratingEligibleTournamentIds: [],
        membershipOnlyTournamentIds: [],
        directionEvidence: "RECORD_OR_PROVIDER",
      };
      current.tournamentIds = unique([...current.tournamentIds, tournamentId]).sort();
      current.publicationIds = unique([...current.publicationIds, ...publicationIds]).sort();
      current.ratingEligibleTournamentIds = ratingEligible
        ? unique([...current.ratingEligibleTournamentIds, tournamentId]).sort()
        : current.ratingEligibleTournamentIds;
      current.membershipOnlyTournamentIds = ratingEligible
        ? current.membershipOnlyTournamentIds
        : unique([...current.membershipOnlyTournamentIds, tournamentId]).sort();
      operationsByMembership.set(membershipKey, current);
    });
  });

  const operations = Array.from(operationsByMembership.values()).sort((left, right) => (
    left.communityId.localeCompare(right.communityId) || left.playerId.localeCompare(right.playerId)
  ));
  const sourceFingerprintSha256 = hashBackfillPlan({
    scope,
    communities: sortCanonicalRows(communities),
    feedPosts: sortCanonicalRows(feedPosts),
    tournaments: sortCanonicalRows(tournaments),
    participantRosters: canonicalize(participantRosters),
    inventoryCoverage: canonicalize(inventoryCoverage),
  });
  const decisionFingerprintSha256 = hashBackfillPlan({
    quarantined: sortCanonicalRows(quarantined),
    skipped: sortCanonicalRows(skipped),
  });
  const plan = {
    version: TIME_FOR_FRIENDS_BACKFILL_VERSION,
    directionId: TIME_FOR_FRIENDS_DIRECTION_ID,
    scopeVersion: scope.version,
    exactScope: scope,
    inventoryCoverage: canonicalize(inventoryCoverage),
    sourceFingerprintSha256,
    decisionFingerprintSha256,
    operations,
    affectedCommunityIds: unique(operations.map((row) => row.communityId)).sort(),
  };
  const countByReason = (rows) => Object.fromEntries(
    Object.entries(rows.reduce((counts, row) => {
      const reason = toStringOrNull(row.reason) || "UNKNOWN";
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {})).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    plan,
    planSha256: hashBackfillPlan(plan),
    summary: {
      matchedTournaments,
      operations: operations.length,
      alreadyMembers: skipped.filter((row) => row.reason === "ALREADY_MEMBER").length,
      skippedRosterRows: skipped.filter((row) => row.reason !== "ALREADY_MEMBER").length,
      skipped: skipped.length,
      skippedByReason: countByReason(skipped),
      quarantined: quarantined.length,
      quarantinedByReason: countByReason(quarantined),
      providerStatusCounts: Object.fromEntries(
        Object.entries(providerStatusCounts).sort(([left], [right]) => left.localeCompare(right)),
      ),
      affectedCommunities: plan.affectedCommunityIds.length,
      ratingEligibleOperations: operations.filter((row) => row.ratingEligibleTournamentIds.length > 0).length,
      membershipOnlyOperations: operations.filter((row) => row.membershipOnlyTournamentIds.length > 0).length,
    },
    skipped,
    quarantined,
  };
}

export function buildRedactedBackfillReport(result, metadata = {}) {
  const redactEntry = (entry) => ({
    ...entry,
    ...(entry.playerId ? { playerId: redactPlayerId(entry.playerId) } : {}),
  });
  return {
    ok: result.quarantined.length === 0,
    mode: metadata.mode || "dry-run",
    generatedAt: metadata.generatedAt || new Date().toISOString(),
    version: TIME_FOR_FRIENDS_BACKFILL_VERSION,
    planSha256: result.planSha256,
    summary: result.summary,
    affectedCommunityIds: result.plan.affectedCommunityIds,
    inventoryCoverage: result.plan.inventoryCoverage,
    operations: result.plan.operations.map((row) => ({
      operationId: row.operationId,
      communityId: row.communityId,
      stationId: row.stationId,
      playerRef: redactPlayerId(row.playerId),
      tournamentIds: row.tournamentIds,
      publicationIds: row.publicationIds,
      ratingEligibleTournamentIds: row.ratingEligibleTournamentIds,
      membershipOnlyTournamentIds: row.membershipOnlyTournamentIds,
      directionEvidence: row.directionEvidence,
    })),
    skipped: result.skipped.map(redactEntry),
    quarantined: result.quarantined.map(redactEntry),
    apply: metadata.apply || null,
  };
}

export function buildTimeForFriendsAtomicMembershipMutation(operation, nowIso) {
  const communityId = toStringOrNull(operation?.communityId);
  const playerId = toStringOrNull(operation?.playerId);
  const phoneNorm = normalizePhone(operation?.phoneNorm);
  const joinedAt = toStringOrNull(nowIso);
  if (!communityId || !playerId || !joinedAt) {
    throw new Error("Atomic membership mutation requires communityId, playerId and nowIso");
  }
  const identityFields = ["id", "clientId", "playerId", "userId"];
  const phoneFields = ["phoneNorm", "phone", "phoneNumber", "mobile"];
  const identityClauses = [
    ...identityFields.map((field) => ({ [field]: playerId })),
    ...(phoneNorm ? phoneFields.map((field) => ({ [field]: phoneNorm })) : []),
  ];
  const arrayExpression = (field) => ({ $cond: [{ $isArray: `$${field}` }, `$${field}`, []] });
  const noPhoneOnlyIdentity = (field) => ({
    $eq: [{
      $size: {
        $filter: {
          input: arrayExpression(field),
          as: "identity",
          cond: {
            $and: [
              ...identityFields.map((identityField) => ({
                $eq: [{ $ifNull: [`$$identity.${identityField}`, null] }, null],
              })),
              {
                $or: phoneFields.map((phoneField) => ({
                  $ne: [{ $ifNull: [`$$identity.${phoneField}`, null] }, null],
                })),
              },
            ],
          },
        },
      },
    }, 0],
  });
  const currentMembers = arrayExpression("members");
  const member = {
    id: playerId,
    name: toStringOrNull(operation.playerName) || "Игрок",
    role: "MEMBER",
    status: "ACTIVE",
    joinedAt,
    joinSource: {
      type: toStringOrNull(operation.joinSourceType) || "TIME_FOR_FRIENDS_TOURNAMENT_BACKFILL",
      version: toStringOrNull(operation.joinSourceVersion) || TIME_FOR_FRIENDS_BACKFILL_VERSION,
      tournamentIds: asArray(operation.tournamentIds),
    },
  };
  return {
    filter: {
      id: communityId,
      archived: { $ne: true },
      members: { $not: { $elemMatch: { $or: identityClauses } } },
      bannedMembers: { $not: { $elemMatch: { $or: identityClauses } } },
      ...(!phoneNorm ? {
        $expr: {
          $and: [noPhoneOnlyIdentity("members"), noPhoneOnlyIdentity("bannedMembers")],
        },
      } : {}),
    },
    update: [{
      $set: {
        members: { $concatArrays: [currentMembers, [member]] },
        memberCount: { $add: [{ $size: currentMembers }, 1] },
        pendingMembers: {
          $filter: {
            input: arrayExpression("pendingMembers"),
            as: "pending",
            cond: {
              $and: identityClauses.map((clause) => {
                const [field, value] = Object.entries(clause)[0];
                return { $ne: [{ $ifNull: [`$$pending.${field}`, null] }, value] };
              }),
            },
          },
        },
        updatedAt: joinedAt,
      },
    }],
  };
}

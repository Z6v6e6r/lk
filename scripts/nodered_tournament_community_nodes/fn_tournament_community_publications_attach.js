const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const nested = (record, path) => {
  let current = record;
  for (const part of path) {
    if (!isObj(current)) return null;
    current = current[part];
  }
  return current;
};
const first = (record, paths) => {
  for (const path of paths) {
    const value = toStr(nested(record, path));
    if (value) return value;
  }
  return null;
};
const publicationTournamentId = (post) => first(post, [
  ["relatedTournamentId"],
  ["tournamentId"],
  ["details", "relatedTournamentId"],
  ["details", "publicTournament", "exerciseId"],
  ["details", "publicTournament", "tournamentId"],
]);
const publicationRole = (post) => String(first(post, [
  ["publicationRole"],
  ["ratingRole"],
  ["details", "publicationRole"],
  ["details", "ratingRole"],
  ["details", "publicTournament", "publicationRole"],
]) || "DISCOVERY_ONLY").toUpperCase() === "RATING_PRIMARY"
  ? "RATING_PRIMARY"
  : "DISCOVERY_ONLY";
const stationId = (post) => first(post, [
  ["stationId"],
  ["studioId"],
  ["details", "stationId"],
  ["details", "studioId"],
  ["details", "publicTournament", "studio", "id"],
]);

const context = isObj(msg._tournamentCommunityContext) ? msg._tournamentCommunityContext : {};
const feedRows = Array.isArray(msg.payload) ? msg.payload : [];
const byCommunity = new Map();
feedRows.forEach((post) => {
  if (!isObj(post) || post.archived === true || publicationTournamentId(post) !== context.tournamentId) return;
  const communityId = toStr(post.communityId);
  if (!communityId) return;
  const row = {
    communityId,
    communityName: first(post, [["communityName"], ["details", "communityName"]]),
    publicationId: toStr(post.id ?? post._id),
    role: publicationRole(post),
    stationId: stationId(post),
  };
  const current = byCommunity.get(communityId);
  if (!current || row.role === "RATING_PRIMARY") byCommunity.set(communityId, row);
});
const publishedCommunities = [...byCommunity.values()].sort((left, right) => (
  left.communityId.localeCompare(right.communityId)
));
const primaries = publishedCommunities.filter((row) => row.role === "RATING_PRIMARY");
const ratingCommunityId = primaries.length === 1
  ? primaries[0].communityId
  : primaries.length === 0 && publishedCommunities.length === 1
    ? publishedCommunities[0].communityId
    : null;
const ratingCommunityStatus = ratingCommunityId
  ? "RESOLVED"
  : publishedCommunities.length === 0
    ? "NOT_PUBLISHED"
    : "AMBIGUOUS";

msg.payload = (Array.isArray(context.sourceRows) ? context.sourceRows : []).map((tournament) => ({
  ...tournament,
  publishedCommunities,
  ratingCommunityId,
  ratingCommunityStatus,
}));
delete msg._tournamentCommunityContext;
return msg;

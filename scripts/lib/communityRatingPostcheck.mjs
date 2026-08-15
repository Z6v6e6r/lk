const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toStr = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text || "";
};
const asNumber = (value) => Number(value);
const roundToThreeDigits = (value) => Math.round(value * 1000) / 1000;
const unique = (values) => Array.from(new Set(values.filter(Boolean)));

export const normalizeCommunityId = (value) => toStr(value);

export const extractActiveCommunityIds = (rows) => {
  const ids = rows
    .filter((row) => row?.archived !== true)
    .map((row) => normalizeCommunityId(row?.id || row?.communityId));
  return unique(ids);
};

const buildSnapshotMatrix = (periods, tabs) => Object.fromEntries(
  periods.flatMap((period) => tabs.map((tab) => [`${period}:${tab}`, 0])),
);

export const buildCommunityRatingPostcheckReport = ({
  activeCommunityRows,
  snapshotRows,
  periods,
  tabs,
  overallWeights,
  calculationVersion,
}) => {
  const activeCommunityIds = extractActiveCommunityIds(activeCommunityRows);
  const activeCommunitySet = new Set(activeCommunityIds);
  const matrix = buildSnapshotMatrix(periods, tabs);
  let activeSnapshots = 0;
  let snapshotsMissingCommunityId = 0;
  let orphanSnapshots = 0;
  const orphanSnapshotCommunities = new Set();
  let items = 0;
  let itemsMissingLastChangeFields = 0;
  let overallFormulaMismatches = 0;
  let overallRowsWithLastRatingChange = 0;
  const uniqueKeys = new Set();

  snapshotRows.forEach((snapshot) => {
    const normalizedCommunityId = normalizeCommunityId(snapshot?.communityId);
    if (!normalizedCommunityId) {
      snapshotsMissingCommunityId += 1;
      return;
    }

    const isActiveSnapshot = activeCommunitySet.has(normalizedCommunityId);
    if (isActiveSnapshot) {
      activeSnapshots += 1;
      const key = `${normalizedCommunityId}:${snapshot.period}:${snapshot.tab}`;
      uniqueKeys.add(key);
      const matrixKey = `${snapshot.period}:${snapshot.tab}`;
      if (Object.hasOwn(matrix, matrixKey)) matrix[matrixKey] += 1;
      const snapshotItems = Array.isArray(snapshot.items) ? snapshot.items : [];
      items += snapshotItems.length;
      snapshotItems.forEach((item) => {
        if (
          !isRecord(item)
          || !Object.hasOwn(item, "lastRatingDelta")
          || !Object.hasOwn(item, "lastRatingChangedAt")
        ) itemsMissingLastChangeFields += 1;
        if (snapshot.tab === "overall" && isRecord(item)) {
          const games = asNumber(item.gamesNormalized);
          const tournaments = asNumber(item.tournamentNormalized);
          const activity = asNumber(item.activityScore);
          const overall = asNumber(item.overallScore);
          const expected = roundToThreeDigits(
            games * overallWeights.games
            + tournaments * overallWeights.tournaments
            + activity * overallWeights.activity
          );
          if (
            !Number.isFinite(games)
            || !Number.isFinite(tournaments)
            || !Number.isFinite(activity)
            || !Number.isFinite(overall)
            || Math.abs(overall - expected) > 0.001
          ) overallFormulaMismatches += 1;
          if (Number.isFinite(Number(item.lastRatingDelta)) && Number(item.lastRatingDelta) !== 0) {
            overallRowsWithLastRatingChange += 1;
          }
        }
      });
      return;
    }

    orphanSnapshots += 1;
    orphanSnapshotCommunities.add(normalizedCommunityId);
  });

  const expectedSnapshots = activeCommunityIds.length * periods.length * tabs.length;
  const matrixComplete = Object.values(matrix).every((count) => count === activeCommunityIds.length);
  const ok = (
    snapshotsMissingCommunityId === 0
    && activeSnapshots === expectedSnapshots
    && uniqueKeys.size === expectedSnapshots
    && matrixComplete
    && itemsMissingLastChangeFields === 0
    && overallFormulaMismatches === 0
    && overallRowsWithLastRatingChange > 0
  );

  return {
    ok,
    calculationVersion,
    activeCommunities: activeCommunityIds.length,
    expectedSnapshots,
    snapshots: snapshotRows.length,
    activeSnapshots,
    uniqueSnapshotKeys: uniqueKeys.size,
    orphanSnapshots,
    orphanSnapshotCommunities: orphanSnapshotCommunities.size,
    matrix,
    items,
    itemsMissingLastChangeFields,
    overallFormulaMismatches,
    overallRowsWithLastRatingChange,
    snapshotsMissingCommunityId,
  };
};

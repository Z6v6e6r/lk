const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const toTimestamp = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.parse(value);
};

const documentIdentityFilter = (document) => {
  if (document?._id !== null && document?._id !== undefined) return { _id: document._id };
  const id = toStr(document?.id);
  return id ? { id } : null;
};

const GAME_RESULT_GUARD_FIELDS = [
  "resultId",
  "resultStatus",
  "resultLifecycleState",
  "lastResultAt",
];

export const buildGameRepairFilter = ({ game, gameId }) => {
  const filter = {
    id: gameId,
    archived: { $ne: true },
  };
  GAME_RESULT_GUARD_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(game || {}, field) && game[field] !== undefined) {
      filter[field] = game[field];
    } else {
      filter[field] = { $exists: false };
    }
  });
  return filter;
};

export const buildRatingEventRevertOperation = ({
  event,
  gameId,
  activeResultIds = [],
  nowIso,
  nowTs = toTimestamp(nowIso),
  reason,
  source,
}) => {
  const identity = documentIdentityFilter(event);
  if (!identity) return null;

  const previousStatus = toStr(event?.status);
  if (previousStatus?.toUpperCase() === "REVERTED") return null;

  const resultId = toStr(event?.resultId);
  const knownResultIds = new Set(activeResultIds.map(toStr).filter(Boolean));
  const orphanedResult = !resultId || !knownResultIds.has(resultId);
  const filter = {
    ...identity,
    gameId,
  };
  if (Object.prototype.hasOwnProperty.call(event || {}, "status")) {
    filter.status = event.status;
  } else {
    filter.status = { $exists: false };
  }

  return {
    updateOne: {
      filter,
      update: {
        $set: {
          status: "REVERTED",
          revertedAt: nowIso,
          revertedAtTs: nowTs,
          repairedAt: nowIso,
          repairedAtTs: nowTs,
          repairReason: reason,
          repairSource: source,
          repair: {
            at: nowIso,
            atTs: nowTs,
            reason,
            source,
            gameId,
            resultId,
            previousStatus,
            orphanedResult,
          },
          updatedAt: nowIso,
        },
      },
      upsert: false,
    },
  };
};

export const buildResultSessionResetOperation = ({
  session,
  gameId,
  resultIds = [],
  nowIso,
  nowTs = toTimestamp(nowIso),
  reason,
  source,
}) => {
  const identity = documentIdentityFilter(session);
  if (!identity || session?.deleted === true) return null;

  const rawRevision = session?.revision;
  const currentRevision = Number.isInteger(Number(rawRevision)) && Number(rawRevision) >= 0
    ? Number(rawRevision)
    : 0;
  const filter = {
    ...identity,
    gameId,
    deleted: { $ne: true },
  };
  if (Object.prototype.hasOwnProperty.call(session || {}, "revision")) {
    filter.revision = rawRevision;
  } else {
    filter.revision = { $exists: false };
  }

  return {
    updateOne: {
      filter,
      update: {
        $set: {
          status: "RESET_FOR_REOPEN",
          revision: currentRevision + 1,
          draftSets: [],
          draftPairings: [],
          attachments: [],
          repairedAt: nowIso,
          repairedAtTs: nowTs,
          repairReason: reason,
          repairSource: source,
          resultRepair: {
            at: nowIso,
            atTs: nowTs,
            reason,
            source,
            previousStatus: toStr(session?.status),
            previousRevision: currentRevision,
            resultIds: resultIds.map(toStr).filter(Boolean),
          },
          updatedAt: nowIso,
          updatedTs: nowTs,
        },
        $unset: {
          resultRosterSnapshot: "",
          rosterSnapshot: "",
          lastTouchedBy: "",
          lastTouchedAt: "",
          lastTouchedAtTs: "",
        },
      },
      upsert: false,
    },
  };
};

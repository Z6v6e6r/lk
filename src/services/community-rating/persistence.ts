import {
  buildCommunityRatingAggregates,
  buildCommunityRatingSnapshots,
  type CommunityRatingAggregate,
  type CommunityRatingSnapshot,
} from "./aggregates.ts";
import {
  COMMUNITY_RATING_CALCULATION_VERSION,
  COMMUNITY_RATING_PERIODS,
  COMMUNITY_RATING_TABS,
  normalizeCommunityRatingPeriod,
  normalizeCommunityRatingTab,
  type CommunityRatingPeriod,
  type CommunityRatingTab,
  type CommunityRatingTabInput,
} from "./contract.ts";
import {
  COMMUNITY_RATING_COLLECTIONS,
  type CommunityRatingFact,
  type CommunityRatingMemberSeed,
} from "./facts.ts";

type CommunityRatingCollectionName =
  (typeof COMMUNITY_RATING_COLLECTIONS)[keyof typeof COMMUNITY_RATING_COLLECTIONS];

export interface CommunityRatingReplaceOneOperation<TDocument> {
  replaceOne: {
    filter: Record<string, unknown>;
    replacement: TDocument;
    upsert: true;
  };
}

export interface CommunityRatingDeleteManyOperation {
  deleteMany: {
    filter: Record<string, unknown>;
  };
}

export type CommunityRatingBulkOperation<TDocument> =
  | CommunityRatingReplaceOneOperation<TDocument>
  | CommunityRatingDeleteManyOperation;

export interface CommunityRatingPersistenceBatch {
  ordered: true;
  communityId: string;
  calculationVersion: string;
  collections: typeof COMMUNITY_RATING_COLLECTIONS;
  operations: {
    [COMMUNITY_RATING_COLLECTIONS.facts]: Array<CommunityRatingBulkOperation<CommunityRatingFact>>;
    [COMMUNITY_RATING_COLLECTIONS.aggregates]: Array<CommunityRatingBulkOperation<CommunityRatingAggregate>>;
    [COMMUNITY_RATING_COLLECTIONS.snapshots]: Array<CommunityRatingReplaceOneOperation<CommunityRatingSnapshot>>;
  };
  summary: {
    factDeletes: number;
    factsUpserts: number;
    aggregateDeletes: number;
    aggregateUpserts: number;
    snapshotUpserts: number;
  };
}

export interface BuildCommunityRatingPersistenceBatchParams {
  communityId: string;
  facts: CommunityRatingFact[];
  members?: CommunityRatingMemberSeed[] | null;
  periods?: Array<CommunityRatingPeriod | string> | null;
  tabs?: Array<CommunityRatingTabInput | string> | null;
  nowTs?: number;
  updatedAt?: string | null;
  calculationVersion?: string | null;
}

function unique<TValue extends string>(items: TValue[]): TValue[] {
  return Array.from(new Set(items));
}

function normalizePeriods(periods: BuildCommunityRatingPersistenceBatchParams["periods"]): CommunityRatingPeriod[] {
  return unique((periods?.length ? periods : [...COMMUNITY_RATING_PERIODS])
    .map((period) => normalizeCommunityRatingPeriod(period)));
}

function normalizeTabs(tabs: BuildCommunityRatingPersistenceBatchParams["tabs"]): CommunityRatingTab[] {
  return unique((tabs?.length ? tabs : [...COMMUNITY_RATING_TABS])
    .map((tab) => normalizeCommunityRatingTab(tab)));
}

function getFactUpsertFilter(fact: CommunityRatingFact): Record<string, unknown> {
  return {
    communityId: fact.communityId,
    eventType: fact.eventType,
    eventId: fact.eventId,
    playerKey: fact.playerKey,
    calculationVersion: fact.calculationVersion,
  };
}

function getFactsDeleteFilter(communityId: string, calculationVersion: string): Record<string, unknown> {
  return {
    communityId,
    calculationVersion,
  };
}

function getAggregatePeriodFilter(
  communityId: string,
  period: CommunityRatingPeriod,
  calculationVersion: string,
): Record<string, unknown> {
  return {
    communityId,
    period,
    calculationVersion,
  };
}

function getAggregateUpsertFilter(aggregate: CommunityRatingAggregate): Record<string, unknown> {
  return {
    communityId: aggregate.communityId,
    period: aggregate.period,
    playerKey: aggregate.playerKey,
    calculationVersion: aggregate.calculationVersion,
  };
}

function getSnapshotUpsertFilter(snapshot: CommunityRatingSnapshot): Record<string, unknown> {
  return {
    communityId: snapshot.communityId,
    period: snapshot.period,
    tab: snapshot.tab,
    calculationVersion: snapshot.calculationVersion,
  };
}

function dedupeFactsById(
  facts: CommunityRatingFact[],
  communityId: string,
  calculationVersion: string,
): CommunityRatingFact[] {
  const factById = new Map<string, CommunityRatingFact>();
  facts.forEach((fact) => {
    if (fact.communityId !== communityId) return;
    if (fact.calculationVersion !== calculationVersion) return;
    factById.set(fact.id, fact);
  });
  return Array.from(factById.values());
}

export function buildCommunityRatingPersistenceBatch(
  params: BuildCommunityRatingPersistenceBatchParams,
): CommunityRatingPersistenceBatch {
  const communityId = params.communityId.trim();
  const calculationVersion = params.calculationVersion || COMMUNITY_RATING_CALCULATION_VERSION;
  const periods = normalizePeriods(params.periods);
  const tabs = normalizeTabs(params.tabs);
  const facts = dedupeFactsById(params.facts, communityId, calculationVersion);

  const factOperations: Array<CommunityRatingBulkOperation<CommunityRatingFact>> = [
    {
      deleteMany: {
        filter: getFactsDeleteFilter(communityId, calculationVersion),
      },
    },
    ...facts.map((fact): CommunityRatingReplaceOneOperation<CommunityRatingFact> => ({
      replaceOne: {
        filter: getFactUpsertFilter(fact),
        replacement: fact,
        upsert: true,
      },
    })),
  ];

  const aggregateOperations: Array<CommunityRatingBulkOperation<CommunityRatingAggregate>> = [];
  periods.forEach((period) => {
    aggregateOperations.push({
      deleteMany: {
        filter: getAggregatePeriodFilter(communityId, period, calculationVersion),
      },
    });

    buildCommunityRatingAggregates({
      communityId,
      facts,
      members: params.members,
      period,
      nowTs: params.nowTs,
      updatedAt: params.updatedAt,
      calculationVersion,
    }).forEach((aggregate) => {
      aggregateOperations.push({
        replaceOne: {
          filter: getAggregateUpsertFilter(aggregate),
          replacement: aggregate,
          upsert: true,
        },
      });
    });
  });

  const snapshots = buildCommunityRatingSnapshots({
    communityId,
    facts,
    members: params.members,
    periods,
    tabs,
    nowTs: params.nowTs,
    updatedAt: params.updatedAt,
    calculationVersion,
  });
  const snapshotOperations = snapshots.map((snapshot): CommunityRatingReplaceOneOperation<CommunityRatingSnapshot> => ({
    replaceOne: {
      filter: getSnapshotUpsertFilter(snapshot),
      replacement: snapshot,
      upsert: true,
    },
  }));

  const aggregateDeletes = aggregateOperations.filter((operation) => "deleteMany" in operation).length;
  const aggregateUpserts = aggregateOperations.filter((operation) => "replaceOne" in operation).length;

  return {
    ordered: true,
    communityId,
    calculationVersion,
    collections: COMMUNITY_RATING_COLLECTIONS,
    operations: {
      [COMMUNITY_RATING_COLLECTIONS.facts]: factOperations,
      [COMMUNITY_RATING_COLLECTIONS.aggregates]: aggregateOperations,
      [COMMUNITY_RATING_COLLECTIONS.snapshots]: snapshotOperations,
    },
    summary: {
      factDeletes: 1,
      factsUpserts: facts.length,
      aggregateDeletes,
      aggregateUpserts,
      snapshotUpserts: snapshotOperations.length,
    },
  };
}

export function getCommunityRatingBatchCollectionOrder(): CommunityRatingCollectionName[] {
  return [
    COMMUNITY_RATING_COLLECTIONS.facts,
    COMMUNITY_RATING_COLLECTIONS.aggregates,
    COMMUNITY_RATING_COLLECTIONS.snapshots,
  ];
}

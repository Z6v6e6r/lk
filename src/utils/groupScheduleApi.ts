import {
  API_BASE,
  IS_DEV_RELEASE_CHANNEL,
  TENANT_KEY,
} from "../consts/api_config";
import {
  request,
  type ApiResult,
} from "./apiClient";
import {
  buildGroupScheduleSourceQueries,
  mergeGroupTrainingLists,
  normalizeGroupTraining,
  normalizeGroupTrainingList,
  type GroupTrainingSummary,
} from "./groupScheduleModel";

export {
  GROUP_SCHEDULE_ALLOWED_TYPE_IDS,
  GROUP_SCHEDULE_AVAILABLE_STUDIO_IDS,
  GROUP_SCHEDULE_BOOKING_DAYS,
  GROUP_SCHEDULE_GAME_PLUS_TRAINER_TYPE_ID,
  GROUP_SCHEDULE_PITER_STUDIO_ID,
  buildGroupScheduleSourceQueries,
  getGroupTrainingTypeId,
  isGamePlusTrainerSummary,
  isGamePlusTrainerTraining,
  isGroupTrainingAllowed,
  mergeGroupTrainingLists,
  normalizeGroupTraining,
  normalizeGroupTrainingList,
} from "./groupScheduleModel";
export type {
  GroupScheduleTrainer,
  GroupTrainingStatus,
  GroupTrainingSummary,
} from "./groupScheduleModel";

const groupScheduleRequestOptions = {
  method: "GET" as const,
  retries: 1,
  ...(IS_DEV_RELEASE_CHANNEL
    ? {
        cacheTtlMs: 30_000,
        dedupe: true,
      }
    : {
        cache: "no-store" as RequestCache,
      }),
};

function requestGroupTrainingsByDateRaw(
  query: string,
): Promise<ApiResult<unknown>> {
  return request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises${query}`,
    groupScheduleRequestOptions,
  );
}

export async function apiFetchGroupTrainingsByDate(
  date: string,
): Promise<ApiResult<GroupTrainingSummary[]>> {
  const [baseQuery, piterQuery] = buildGroupScheduleSourceQueries(date);
  const [baseResult, piterResult] = await Promise.all([
    requestGroupTrainingsByDateRaw(baseQuery),
    requestGroupTrainingsByDateRaw(piterQuery),
  ]);

  if (baseResult.error) {
    return {
      data: null,
      error: baseResult.error,
      status: baseResult.status,
    };
  }

  const baseTrainings = normalizeGroupTrainingList(baseResult.data);

  if (piterResult.error) {
    return {
      data: baseTrainings,
      error: null,
      status: baseResult.status,
    };
  }

  const piterTrainings = normalizeGroupTrainingList(piterResult.data);

  return {
    data: mergeGroupTrainingLists(baseTrainings, piterTrainings),
    error: null,
    status: baseResult.status,
  };
}

export async function apiFetchGroupTrainingDetail(
  exerciseId: string,
): Promise<ApiResult<GroupTrainingSummary>> {
  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises/${encodeURIComponent(exerciseId)}`,
    {
      method: "GET",
      retries: 1,
    },
  );
  if (result.error) {
    return {
      data: null,
      error: result.error,
      status: result.status,
    };
  }
  const training = normalizeGroupTraining(result.data);
  return {
    data: training,
    error: training ? null : { status: result.status, message: "Тренировка не найдена в расписании" },
    status: result.status,
  };
}

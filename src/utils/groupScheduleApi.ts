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
  buildGroupScheduleQuery,
  normalizeGroupTraining,
  normalizeGroupTrainingList,
  type GroupTrainingSummary,
} from "./groupScheduleModel";

export {
  GROUP_SCHEDULE_ALLOWED_TYPE_IDS,
  GROUP_SCHEDULE_AVAILABLE_STUDIO_IDS,
  GROUP_SCHEDULE_BOOKING_DAYS,
  GROUP_SCHEDULE_GAME_PLUS_TRAINER_TYPE_ID,
  getGroupTrainingTypeId,
  isGamePlusTrainerSummary,
  isGamePlusTrainerTraining,
  isGroupTrainingAllowed,
  normalizeGroupTraining,
  normalizeGroupTrainingList,
} from "./groupScheduleModel";
export type {
  GroupScheduleTrainer,
  GroupTrainingStatus,
  GroupTrainingSummary,
} from "./groupScheduleModel";

export async function apiFetchGroupTrainingsByDate(
  date: string,
): Promise<ApiResult<GroupTrainingSummary[]>> {
  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises${buildGroupScheduleQuery({ date })}`,
    {
      method: "GET",
      retries: 1,
      ...(IS_DEV_RELEASE_CHANNEL
        ? {
            cacheTtlMs: 30_000,
            dedupe: true,
          }
        : {
            cache: "no-store" as RequestCache,
          }),
    },
  );
  if (result.error) {
    return {
      data: null,
      error: result.error,
      status: result.status,
    };
  }
  return {
    data: normalizeGroupTrainingList(result.data),
    error: null,
    status: result.status,
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

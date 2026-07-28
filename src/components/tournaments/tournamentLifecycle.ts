import type { TournamentHistoryRecord } from "../../utils/apiClient";

export type TournamentProgressState = "not_started" | "in_progress" | "completed";

export interface TournamentFinishConfirmationCopy {
  title: string;
  progress: string;
  warning: string;
  reassurance: string;
  confirmLabel: string;
}

const COMPLETED_STATUSES = new Set([
  "completed",
  "finished",
  "closed",
  "done",
  "завершен",
  "завершён",
]);

const IN_PROGRESS_STATUSES = new Set([
  "in_progress",
  "progress",
  "active",
  "started",
  "running",
  "open",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function isTruthyFlag(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function getRecordStatuses(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  return [
    record.status,
    record.state,
    record.tournamentStatus,
  ]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean);
}

function hasCompletedStatus(record: Record<string, unknown> | null): boolean {
  return getRecordStatuses(record).some((status) => COMPLETED_STATUSES.has(status));
}

function hasInProgressStatus(record: Record<string, unknown> | null): boolean {
  return getRecordStatuses(record).some((status) => IN_PROGRESS_STATUSES.has(status));
}

function hasFinishMarker(record: Record<string, unknown> | null, includeManualFinishedAt = false): boolean {
  if (!record) return false;
  const markers = [
    record.finishedAt,
    record.completedAt,
    ...(includeManualFinishedAt ? [record.manualFinishedAt] : []),
  ];
  return markers.some((value) => value != null && String(value).trim() !== "");
}

function hasFinishFlag(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  return [
    record.finished,
    record.isFinished,
    record.tournamentFinished,
    record.manualFinish,
  ].some((value) => isTruthyFlag(value));
}

function isRecordMarkedFinished(record: Record<string, unknown> | null, includeManualFinishedAt = false): boolean {
  return hasCompletedStatus(record) || hasFinishMarker(record, includeManualFinishedAt) || hasFinishFlag(record);
}

function isCompletedHistoryMatch(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.score1 != null && record.score2 != null;
}

export function isTournamentMarkedFinished(paramsInput: unknown, summaryInput: unknown): boolean {
  const params = asRecord(paramsInput);
  const summary = asRecord(summaryInput);
  return isRecordMarkedFinished(params, true) || isRecordMarkedFinished(summary);
}

export function isTournamentManuallyFinished(paramsInput: unknown, summaryInput: unknown): boolean {
  const params = asRecord(paramsInput);
  const summary = asRecord(summaryInput);
  return isTruthyFlag(params?.manualFinish) || isTruthyFlag(summary?.manualFinish);
}

export function buildTournamentFinishConfirmationCopy(input: {
  completedMatches: number;
  totalMatches: number;
  hasPartiallyCompletedRound: boolean;
}): TournamentFinishConfirmationCopy {
  const totalMatches = Math.max(0, Math.trunc(Number(input.totalMatches) || 0));
  const completedMatches = Math.min(
    totalMatches,
    Math.max(0, Math.trunc(Number(input.completedMatches) || 0)),
  );
  const remainingMatches = Math.max(0, totalMatches - completedMatches);
  const remainingModulo100 = remainingMatches % 100;
  const remainingModulo10 = remainingMatches % 10;
  const remainingMatchLabel = remainingModulo100 >= 11 && remainingModulo100 <= 14
    ? "матчей останутся"
    : remainingModulo10 === 1
      ? "матч останется"
      : remainingModulo10 >= 2 && remainingModulo10 <= 4
        ? "матча останутся"
        : "матчей останутся";

  let warning = "После завершения ввод результатов будет заблокирован.";
  if (input.hasPartiallyCompletedRound) {
    warning = "В текущем раунде есть частично заполненные матчи. Незавершенные матчи не попадут в итоговый счет.";
  } else if (remainingMatches > 0) {
    warning = `${remainingMatches} ${remainingMatchLabel} без результата.`;
  }

  return {
    title: "Завершить турнир?",
    progress: `Сохранено матчей: ${completedMatches} из ${totalMatches}.`,
    warning,
    reassurance: "Если завершение было случайным, турнир можно будет возобновить без потери сетки и сохраненных результатов.",
    confirmLabel: "Да, завершить",
  };
}

export function isClassicMexicanoTournament(input: {
  tournamentType?: string | null;
  params?: Record<string, unknown> | null;
} | null | undefined): boolean {
  const tournamentType = String(input?.tournamentType ?? "").trim().toLowerCase();
  const params = asRecord(input?.params);
  const tournamentFamily = String(params?.tournamentFamily ?? "").trim().toLowerCase();
  const tournamentSubtype = String(params?.tournamentSubtype ?? "").trim().toLowerCase();
  const mexicanoMode = String(params?.mexicanoMode ?? "").trim().toLowerCase();

  if (tournamentType === "paired_mexicano" || mexicanoMode === "paired" || tournamentSubtype === "paired") {
    return false;
  }
  if (tournamentType === "mexicano") {
    return true;
  }
  return tournamentFamily === "mexicano";
}

export function getTournamentProgressState(history: TournamentHistoryRecord | null | undefined): TournamentProgressState {
  if (!history) return "not_started";
  const params = asRecord(history.params);
  if (
    isClassicMexicanoTournament(history) &&
    hasInProgressStatus(params) &&
    !isRecordMarkedFinished(params, true)
  ) {
    return "in_progress";
  }
  if (isTournamentMarkedFinished(params, history.summary)) return "completed";
  if (isClassicMexicanoTournament(history)) return "in_progress";

  const matches = Array.isArray(history.rounds)
    ? history.rounds.flatMap((round) => {
      const record = asRecord(round);
      const roundMatches = record?.matches;
      return Array.isArray(roundMatches) ? roundMatches : [];
    })
    : [];
  if (matches.length === 0) return "in_progress";
  return matches.every((match) => isCompletedHistoryMatch(match)) ? "completed" : "in_progress";
}

export function buildTournamentResumeParams(currentParamsInput: unknown): Record<string, unknown> {
  const currentParams = asRecord(currentParamsInput) ?? {};
  return {
    ...currentParams,
    status: "in_progress",
    state: "in_progress",
    tournamentStatus: "in_progress",
    finished: false,
    isFinished: false,
    tournamentFinished: false,
    manualFinish: false,
    finishedAt: null,
    completedAt: null,
    manualFinishedAt: null,
    resumeRequested: true,
  };
}

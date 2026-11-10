import type { ApiResult, Exercise } from "./apiClient";
import { getTournamentMechanicsExerciseDateKey, mergeTournamentMechanicsExercises } from "./tournamentMechanicsExercises.ts";
import { isTournamentExerciseCategory } from "./tournamentCategory.ts";
import { isTournamentSignupPayloadCancelled } from "./tournamentSignupCancellation.ts";

function cancelled(exercise: Exercise) {
  return exercise.archived === true || exercise.cancelled === true || exercise.canceled === true
    || exercise.isCancelled === true || isTournamentSignupPayloadCancelled(exercise);
}

export function mergeTournamentDaySchedule(fresh: Exercise[], previous: Exercise[], dateKey: string, now = Date.now()) {
  // Viva's public day feed omits already-started exercises even with includePast.
  // Omission is not a cancellation; explicit fresh cancellation still wins by ID.
  const started = previous.filter(exercise => isTournamentExerciseCategory(exercise)
    && getTournamentMechanicsExerciseDateKey(exercise) === dateKey
    && Date.parse(exercise.timeFrom) <= now && !cancelled(exercise)
    && !fresh.some(item => item.id === exercise.id && getTournamentMechanicsExerciseDateKey(item) !== dateKey));
  return mergeTournamentMechanicsExercises(fresh, started, dateKey).filter(exercise => !cancelled(exercise));
}

export async function loadTournamentDaySchedule(input: {
  dateKey: string;
  previous: Exercise[];
  loadExercises: () => Promise<ApiResult<Exercise[]>>;
  loadSource: () => Promise<ApiResult<Exercise[]>>;
  loadBookings: () => Promise<Exercise[]>;
  onAvailable?: (items: Exercise[]) => void;
  timeoutMs?: number;
}) {
  const responses: { primary: ApiResult<Exercise[]> | null; snapshot: ApiResult<Exercise[]> | null } = {
    primary: null, snapshot: null,
  };
  let bookingItems: Exercise[] = [];
  const combine = () => {
    const removedIds = new Set([...(responses.primary?.data ?? []), ...(responses.snapshot?.data ?? [])]
      .filter(item => cancelled(item) || getTournamentMechanicsExerciseDateKey(item) !== input.dateKey).map(item => item.id));
    const merged = mergeTournamentMechanicsExercises(
      responses.primary?.error ? [] : responses.primary?.data ?? [],
      responses.snapshot?.error ? bookingItems : mergeTournamentMechanicsExercises(responses.snapshot?.data ?? [], bookingItems, input.dateKey),
      input.dateKey,
    );
    const items = mergeTournamentDaySchedule(merged, input.previous.filter(item => !removedIds.has(item.id)), input.dateKey)
      .filter(item => !removedIds.has(item.id));
    return { items, retainedStarted: items.some(item => !merged.some(fresh => fresh.id === item.id)) };
  };
  const publish = () => {
    const result = combine();
    if (result.items.length > 0) input.onAvailable?.(result.items);
  };
  const bounded = async <T>(load: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(load),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Расписание загружается слишком долго")), input.timeoutMs ?? 10_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  // A useful snapshot can be displayed immediately; an empty response cannot
  // finish the load or replace the cached day before independent sources settle.
  await Promise.allSettled([
    bounded(input.loadExercises).then(result => { responses.primary = result; publish(); }),
    bounded(input.loadSource).then(result => { responses.snapshot = result; publish(); }),
    bounded(input.loadBookings).then(result => { bookingItems = result; publish(); }),
  ]);
  if ((!responses.primary || responses.primary.error) && (!responses.snapshot || responses.snapshot.error) && bookingItems.length === 0) {
    throw new Error(responses.snapshot?.error?.message || responses.primary?.error?.message || "Не удалось загрузить список турниров");
  }
  const combined = combine();
  if (combined.items.length === 0 && (!responses.snapshot || responses.snapshot.error)) {
    throw new Error(responses.snapshot?.error?.message || "Не удалось проверить расписание начавшихся турниров");
  }
  return { ...combined, partial: !responses.primary || Boolean(responses.primary.error) || !responses.snapshot || Boolean(responses.snapshot.error) };
}

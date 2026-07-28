import type { Exercise } from "../../utils/apiClient";

function isTournamentTrainer(exercise: Exercise, currentUserId: string | null) {
  if (!currentUserId) return false;
  return (exercise.trainers ?? []).some((trainer) => (trainer.id || "").trim() === currentUserId);
}

export function filterVisibleTournamentExercises(
  tournaments: Exercise[],
  profileId: string | null,
  canHostTournaments: boolean,
  hasProfile: boolean,
) {
  if (!hasProfile) return tournaments;
  if (canHostTournaments) return tournaments;
  return tournaments.filter((exercise) => isTournamentTrainer(exercise, profileId));
}

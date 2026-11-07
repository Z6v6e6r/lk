// Category requested by the owner: individual/split with a Spanish trainer only.
// Do not match other Spanish group trainings or infer a direction ID from a label.
const SPANISH_TRAINING_CATEGORY_NAME = "индивидуальная сплит тренировка испанский тренер";
const spanishTrainingRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const spanishTrainingName = (value: unknown) => typeof value === "string"
  ? value.toLocaleLowerCase("ru-RU").replace(/[^а-яёa-z0-9]+/gi, " ").trim() : "";

export function isSpanishTrainingExercise(value: unknown): boolean {
  if (!spanishTrainingRecord(value)) return false;
  const direction = value.direction ?? value.exerciseDirection;
  const type = value.type ?? value.exerciseType;
  return [
    spanishTrainingRecord(direction) ? direction.name : null,
    spanishTrainingRecord(direction) ? direction.title : null,
    spanishTrainingRecord(type) ? type.name : null,
    value.directionName, value.typeName, value.title, value.name,
  ].some(name => spanishTrainingName(name) === SPANISH_TRAINING_CATEGORY_NAME);
}

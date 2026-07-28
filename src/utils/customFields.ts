import type { CustomField, UserProfileType } from "./apiClient";

export const CUSTOM_FIELD_IDS = {
  vivaPadelLevel: "9018d922-6427-41a6-9ac0-4a2c0440eb8a",
  lkPadelLevel: "f9790818-25fd-4b73-a781-79c02720727d",
  lkPadelLevelNumeric: "eabfe27b-3f72-4496-9185-1a2ec6e6465e",
  tournamentsAccess: "e17a32f3-65f7-47c5-bda1-33d79932c884",
} as const;

const LEVEL_GRADE_LABELS = ["D", "D+", "C", "C+", "B", "B+", "A"] as const;

export function getCustomFieldValue(
  profile: UserProfileType,
  fieldId: string,
): string | undefined {
  return profile.customFields?.find((field) => field?.id === fieldId)?.value?.[0];
}

export function getCustomField(
  profile: UserProfileType,
  fieldId: string,
): CustomField | undefined {
  return profile.customFields?.find((field) => field?.id === fieldId);
}

export function hasTournamentHostingAccess(profile: UserProfileType): boolean {
  const tournamentsField = getCustomField(profile, CUSTOM_FIELD_IDS.tournamentsAccess);
  const tournamentsAccessValue = tournamentsField?.value?.[0];

  return tournamentsAccessValue === "проводит турниры"
    || Boolean(
      tournamentsField?.attributes?.options?.some(
        (option) =>
          option.id === tournamentsAccessValue
          && option.name.toLowerCase() === "проводит турниры",
      ),
    );
}

export function parseNumericLevel(value?: string): number | null {
  if (!value) return null;
  const normalized = value.replace(",", ".");
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : null;
}

export function getLetterGrade(value: number): string {
  if (value < 2) return "D";
  if (value < 3) return "D+";
  if (value < 3.5) return "C";
  if (value < 4) return "C+";
  if (value < 4.7) return "B";
  if (value < 5.5) return "B+";
  return "A";
}

export function normalizeLevelGradeLabel(
  value: string | number | null | undefined,
  numericFallback: number | null = null,
): string | null {
  if (typeof numericFallback === "number" && Number.isFinite(numericFallback)) {
    return getLetterGrade(numericFallback);
  }

  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, "");
  if ((LEVEL_GRADE_LABELS as readonly string[]).includes(compact)) {
    return compact;
  }

  const normalized = compact
    .replace(/¹/g, "1")
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/⁴/g, "4");

  if ((LEVEL_GRADE_LABELS as readonly string[]).includes(normalized)) {
    return normalized;
  }

  const tokenMatch = normalized.match(/^([A-D])([1-4])?(\+)?$/);
  if (tokenMatch) {
    return `${tokenMatch[1]}${tokenMatch[3] || ""}`;
  }

  const numeric = Number.parseFloat(normalized.replace(",", "."));
  if (Number.isFinite(numeric)) {
    return getLetterGrade(numeric);
  }

  return null;
}

export function formatScoreDisplay(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded.toFixed(1).replace(/\.0$/, "");
}

export function formatNumericField(value: number): string {
  return value.toFixed(5).replace(".", ",");
}

export function findCustomFieldIndex(
  customFields: CustomField[] | undefined,
  fieldId: string,
): number {
  if (!customFields) return -1;
  return customFields.findIndex((field) => field?.id === fieldId);
}

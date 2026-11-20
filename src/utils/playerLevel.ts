import type { UserProfileType } from "./apiClient";

export function getProfileLevelNumeric(profile: UserProfileType): number | null {
  return profile.level?.source === "CUP_CANONICAL" && profile.level.status === "RATED" ? profile.level.ratingNumeric : null;
}
export function getProfileLevelGrade(profile: UserProfileType): string | null {
  return profile.level?.source === "CUP_CANONICAL" && profile.level.status === "RATED" ? profile.level.rating : null;
}
export function getProfileLevelNumericText(profile: UserProfileType): string | undefined {
  const n = getProfileLevelNumeric(profile); return n === null ? undefined : String(n);
}

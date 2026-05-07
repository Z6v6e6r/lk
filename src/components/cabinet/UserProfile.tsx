import { useEffect, useState } from "react";
import type { UserProfileType } from "../../utils/apiClient";
import { CUSTOM_FIELD_IDS, getCustomFieldValue, getLetterGrade, parseNumericLevel } from "../../utils/customFields";
import { forceAppRefresh } from "../../utils/forceAppRefresh";

interface UserProfileProps {
  profile: UserProfileType;
  openEditForm: () => void;
}

type Rgb = { r: number; g: number; b: number };

const LEVEL_RANGES = {
  D: { min: 1, max: 2 },
  "D+": { min: 2, max: 3 },
  C: { min: 3, max: 3.5 },
  "C+": { min: 3.5, max: 4 },
  B: { min: 4, max: 4.7 },
  "B+": { min: 4.7, max: 5.5 },
  A: { min: 5.5, max: 7 },
} as const;

type LevelGrade = keyof typeof LEVEL_RANGES;

const LEVEL_RING_COLORS: Record<
  LevelGrade,
  { start: Rgb; end: Rgb; badge: Rgb }
> = {
  A: {
    start: { r: 150, g: 132, b: 255 },
    end: { r: 126, g: 97, b: 255 },
    badge: { r: 130, g: 100, b: 255 },
  },
  "B+": {
    start: { r: 180, g: 118, b: 246 },
    end: { r: 156, g: 78, b: 227 },
    badge: { r: 160, g: 84, b: 230 },
  },
  B: {
    start: { r: 206, g: 104, b: 220 },
    end: { r: 187, g: 63, b: 193 },
    badge: { r: 191, g: 68, b: 196 },
  },
  "C+": {
    start: { r: 228, g: 98, b: 174 },
    end: { r: 213, g: 53, b: 146 },
    badge: { r: 216, g: 58, b: 149 },
  },
  C: {
    start: { r: 238, g: 102, b: 122 },
    end: { r: 223, g: 62, b: 94 },
    badge: { r: 226, g: 67, b: 99 },
  },
  "D+": {
    start: { r: 243, g: 132, b: 96 },
    end: { r: 234, g: 92, b: 51 },
    badge: { r: 236, g: 99, b: 57 },
  },
  D: {
    start: { r: 248, g: 172, b: 104 },
    end: { r: 239, g: 130, b: 34 },
    badge: { r: 241, g: 138, b: 43 },
  },
};

const mixRgb = (from: Rgb, to: Rgb, t: number): Rgb => {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(from.r + (to.r - from.r) * clamped),
    g: Math.round(from.g + (to.g - from.g) * clamped),
    b: Math.round(from.b + (to.b - from.b) * clamped),
  };
};

const toRgbCss = (color: Rgb) => `rgb(${color.r}, ${color.g}, ${color.b})`;
const isLevelGrade = (value: string): value is LevelGrade => value in LEVEL_RANGES;

export function UserProfile({ profile, openEditForm }: UserProfileProps) {
  const [avatarError, setAvatarError] = useState(false);
  const [isRefreshingApp, setIsRefreshingApp] = useState(false);
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  const initials = (profile.firstName?.[0] || "") + (profile.lastName?.[0] || "");
  const balance = (profile.deposit / 100).toLocaleString("ru-RU");
  const numericLevelRaw = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric);
  const numericLevel = parseNumericLevel(numericLevelRaw ?? undefined);
  const letterGrade = numericLevel != null ? getLetterGrade(numericLevel) : null;
  const gradeKey = letterGrade && isLevelGrade(letterGrade) ? letterGrade : null;
  const ringRadius = 27;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const totalSegments = 360;
  const levelRange = gradeKey ? LEVEL_RANGES[gradeKey] : null;
  const numericInRange = levelRange && numericLevel != null
    ? Math.max(levelRange.min, Math.min(levelRange.max, numericLevel))
    : null;
  const rangeProgress = levelRange && numericInRange != null
    ? (numericInRange - levelRange.min) / (levelRange.max - levelRange.min)
    : 0;
  const filledLength = rangeProgress * ringCircumference;
  const ringPalette = gradeKey ? LEVEL_RING_COLORS[gradeKey] : null;

  const badgeRgb: Rgb = ringPalette?.badge ?? { r: 0, g: 0, b: 0 };
  const badgeBrightness = (badgeRgb.r * 299 + badgeRgb.g * 587 + badgeRgb.b * 114) / 1000;
  const badgeStyle = numericLevel != null
    ? {
      backgroundColor: toRgbCss(badgeRgb),
      color: badgeBrightness > 155 ? "#1A1A1A" : "#FFFFFF",
      borderColor: "rgba(255, 255, 255, 0.28)",
    }
    : undefined;

  const hasPhoto = Boolean(profile.photo) && !avatarError;

  useEffect(() => {
    setAvatarError(false);
  }, [profile.photo]);

  const handleForceRefresh = () => {
    if (isRefreshingApp) return;
    setIsRefreshingApp(true);
    void forceAppRefresh();
  };

  return (
    <div className="cab-header">
      <div className="cab-user-row">
        <div className="cab-avatar-wrapper">
          <svg className="cab-avatar-ring" viewBox="0 0 60 60">
            <circle cx="30" cy="30" r={ringRadius} fill="none" stroke="#e5e7eb" strokeWidth="4"/>
            {Array.from({length: totalSegments}, (_, idx) => {
              const i = idx + 1;
              const t = i / totalSegments;
              const segmentLength = ringCircumference / totalSegments;
              const start = idx * segmentLength;
              const remaining = filledLength - start;
              const activeLength = Math.max(0, Math.min(segmentLength, remaining));
              const isActive = activeLength > 0;
              const activeProgress = filledLength > 0
                ? Math.max(0, Math.min(1, (start + activeLength) / filledLength))
                : 0;
              const gradientColor = ringPalette
                ? mixRgb(ringPalette.start, ringPalette.end, Math.pow(activeProgress, 1.08))
                : mixRgb(
                  { r: 180, g: 150, b: 255 },
                  { r: 53, g: 63, b: 185 },
                  Math.pow(t, 3),
                );
              const widthProgress = Math.pow(activeProgress, 1.9);
              const segmentStrokeWidth = 1.35 + widthProgress * 5.55;
              return (
                <circle key={i}
                  cx="30" cy="30" r={ringRadius}
                  fill="none"
                  stroke={isActive ? toRgbCss(gradientColor) : "transparent"}
                  strokeWidth={isActive ? segmentStrokeWidth : 0}
                  strokeDasharray={`${isActive ? activeLength : 0} ${ringCircumference}`}
                  strokeDashoffset={-start}
                  strokeLinecap="butt"
                  transform="rotate(90 30 30)"
                />
              );
            })}
          </svg>
          {hasPhoto ? (
            <img
              src={profile.photo || undefined}
              alt="Аватар"
              className="cab-avatar"
              onError={() => setAvatarError(true)}
            />
          ) : (
            <div className="cab-avatar cab-avatar--fallback">{initials || "?"}</div>
          )}
          <div className="cab-avatar-badge" style={badgeStyle}>{letterGrade || "—"}</div>
        </div>
        <div className="cab-user-info">
          <div className="cab-user-name-row">
            <div className="cab-user-name">{fullName || "Профиль"}</div>
            <button
              className="cab-icon-btn cab-icon-btn--edit"
              onClick={openEditForm}
              title="Редактировать"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M3 21h3.75L17.81 9.94l-3.75-3.75L3 17.25V21zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#1A1A1A"/>
              </svg>
            </button>
          </div>
          <button
            className="cab-refresh-app-btn"
            type="button"
            onClick={handleForceRefresh}
            disabled={isRefreshingApp}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
              <path d="M20 11a8 8 0 0 0-14.7-4.4L4 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 4v4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 13a8 8 0 0 0 14.7 4.4L20 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M20 20v-4h-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>{isRefreshingApp ? "Обновляем..." : "Обновить приложение"}</span>
          </button>
        </div>
        <div className="cab-header-actions">
          <div className="balance-inline">
            <div className="balance-amount balance-amount--compact">{balance} ₽</div>
          </div>
        </div>
      </div>

    </div>
  );
}

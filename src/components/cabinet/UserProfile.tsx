import { useEffect, useState } from "react";
import type { UserProfileType } from "../../utils/apiClient";
import { useDeadlineCountdown } from "../../hooks/useDeadlineCountdown";
import { CUSTOM_FIELD_IDS, getCustomFieldValue, getLetterGrade, parseNumericLevel } from "../../utils/customFields";
import { formatReferralCountdownLabel } from "../../utils/referralSubscription";

interface UserProfileProps {
  profile: UserProfileType;
  openEditForm: () => void;
  onAvatarClick?: () => void;
  shareOffer?: {
    subscriptionName: string;
    url: string;
  } | null;
  renewalOffer?: {
    renewalCountdownEndsAt: string;
    renewalCountdownVisible: boolean;
    subscriptionName: string;
    url: string;
  } | null;
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

function copyPlainTextFallback(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export function UserProfile({ profile, openEditForm, onAvatarClick, shareOffer, renewalOffer }: UserProfileProps) {
  const [avatarError, setAvatarError] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "done" | "error">("idle");
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
  const renewalCountdownMs = useDeadlineCountdown(
    renewalOffer?.renewalCountdownVisible ? renewalOffer.renewalCountdownEndsAt : null,
  );
  const renewalCountdownLabel = formatReferralCountdownLabel(
    renewalOffer?.renewalCountdownVisible ? renewalOffer.renewalCountdownEndsAt : null,
    Date.now(),
  );

  useEffect(() => {
    setAvatarError(false);
  }, [profile.photo]);

  useEffect(() => {
    if (copyState !== "done") return undefined;

    const timeoutId = window.setTimeout(() => {
      setCopyState("idle");
    }, 2500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copyState]);

  const handleCopyReferralLink = async () => {
    if (!shareOffer?.url) return;

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareOffer.url);
      } else if (!copyPlainTextFallback(shareOffer.url)) {
        throw new Error("Clipboard API is not available");
      }
      setCopyState("done");
    } catch {
      setCopyState("error");
    }
  };

  const handleOpenRenewalLink = () => {
    if (!renewalOffer?.url || typeof window === "undefined") return;
    window.location.href = renewalOffer.url;
  };

  return (
    <div className="cab-header">
      <div className="cab-user-row">
        <div className="cab-avatar-column">
          <div className="cab-avatar-tools">
            <button
              type="button"
              className="cab-avatar-tap-target"
              onClick={onAvatarClick}
              disabled={!onAvatarClick}
              aria-label="Открыть информацию об уровнях"
            >
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
            </button>

          </div>

        </div>
        <div className="cab-user-info">
          <div className="cab-user-topline">
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
          </div>
          <div className="cab-user-balance-row">
            <div className="balance-inline balance-inline--header">
              <span className="balance-inline-icon" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9.50033 5.81995V6.31995C9.50033 6.45495 9.39533 6.56495 9.25533 6.56995H8.52533C8.26033 6.56995 8.02033 6.37495 8.00033 6.11495C7.98533 5.95995 8.04533 5.81495 8.14533 5.71495C8.23533 5.61995 8.36033 5.56995 8.49533 5.56995H9.25033C9.39533 5.57495 9.50033 5.68495 9.50033 5.81995Z" fill="currentColor"/>
                  <path d="M7.77 5.34495C7.52 5.58995 7.4 5.95495 7.5 6.33495C7.63 6.79995 8.085 7.09495 8.565 7.09495H9C9.275 7.09495 9.5 7.31995 9.5 7.59495V7.68995C9.5 8.72495 8.655 9.56995 7.62 9.56995H1.88C0.845 9.56995 0 8.72495 0 7.68995V4.32495C0 3.70995 0.295 3.16495 0.75 2.82495C1.065 2.58495 1.455 2.44495 1.88 2.44495H7.62C8.655 2.44495 9.5 3.28995 9.5 4.32495V4.54495C9.5 4.81995 9.275 5.04495 9 5.04495H8.49C8.21 5.04495 7.955 5.15495 7.77 5.34495Z" fill="currentColor"/>
                  <path d="M6.87493 1.41C7.00993 1.545 6.89493 1.755 6.70493 1.755L2.86493 1.75C2.64493 1.75 2.52993 1.48 2.68993 1.325L3.49993 0.51C4.18493 -0.17 5.29493 -0.17 5.97993 0.51L6.85493 1.395C6.85993 1.4 6.86993 1.405 6.87493 1.41Z" fill="currentColor"/>
                </svg>
              </span>
              <span className="balance-inline-content">
                <span className="balance-amount balance-amount--compact">{balance} ₽</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {(shareOffer || renewalOffer) && (
        <div className="cab-header-referral-block">
          {shareOffer && (
            <div className="cab-header-referral-row">
              <button
                type="button"
                className="cab-referral-inline-btn cab-referral-inline-btn--share"
                aria-label={`Поделиться подпиской ${shareOffer.subscriptionName}`}
                onClick={handleCopyReferralLink}
              >
                {copyState === "done" ? "Скопировано" : "Поделиться с другом"}
              </button>
              {copyState === "error" && (
                <div className="cab-referral-inline-error">Не удалось скопировать ссылку.</div>
              )}
            </div>
          )}
          {renewalOffer && (
            <div className="cab-header-referral-row">
              <button
                type="button"
                className="cab-referral-copy-btn cab-referral-copy-btn--renewal"
                aria-label={`Продлить подписку ${renewalOffer.subscriptionName}`}
                onClick={handleOpenRenewalLink}
              >
                <span className="cab-referral-copy-btn-label">Продлить подписку</span>
                {renewalOffer.renewalCountdownVisible && renewalCountdownMs > 0 && (
                  <span className="cab-referral-copy-btn-timer">{renewalCountdownLabel}</span>
                )}
              </button>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

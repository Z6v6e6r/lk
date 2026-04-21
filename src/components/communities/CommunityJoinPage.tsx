import { useCallback, useEffect, useMemo, useState } from "react";
import { CABINET_URL } from "../../consts/api_config";
import {
  apiFetchCommunities,
  apiJoinCommunityByInvite,
  buildCommunityInviteLink,
  buildCommunityLogoCandidates,
  communityErrorMessage,
  extractCommunityInviteCode,
  type CommunityRecord,
} from "../../utils/communityApi";
import { apiFetchProfile, type UserProfileType } from "../../utils/apiClient";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";

interface CommunityJoinPageProps {
  inviteCode?: string | null;
  inviteLink?: string | null;
  cabinetUrl?: string | null;
}

const DEFAULT_CABINET_URL = CABINET_URL;

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function getLevelScoreFromProfile(profile: UserProfileType): number {
  const numericLevel = parseNumericLevel(
    getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric),
  );

  if (typeof numericLevel === "number" && Number.isFinite(numericLevel)) {
    return numericLevel;
  }

  const letterLevel = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel);
  const fallbackLabel = getLetterGrade(3.2);
  const matchedIndex = ["D", "D+", "C", "C+", "B", "B+", "A"].findIndex(
    (value) => value === (letterLevel || fallbackLabel),
  );
  if (matchedIndex >= 0) {
    return matchedIndex + 1.5;
  }

  return 3.2;
}

function buildCommunityActor(profile: UserProfileType) {
  const name = `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || "Игрок";
  const levelScore = getLevelScoreFromProfile(profile);

  return {
    id: profile.id || null,
    phone: profile.phone || null,
    name,
    avatar: profile.photo,
    role: "MEMBER" as const,
    levelScore,
    levelLabel: getLetterGrade(levelScore),
  };
}

function resolveInviteCabinetUrl(value: string | null | undefined): string {
  const fallback = (DEFAULT_CABINET_URL || "").trim();
  const raw = (value || "").trim();
  if (!raw) return fallback;

  try {
    return new URL(raw, typeof window !== "undefined" ? window.location.origin : undefined).toString();
  } catch {
    return raw || fallback;
  }
}

function redirectToCabinet(urlValue: string | null | undefined) {
  if (typeof window === "undefined") return false;

  const target = resolveInviteCabinetUrl(urlValue);
  if (!target) return false;

  try {
    if (window.top && window.top !== window) {
      window.top.location.href = target;
      return true;
    }
  } catch {
    // Fallback to the current window below.
  }

  try {
    window.location.assign(target);
    return true;
  } catch {
    // Fallback to anchor click below.
  }

  try {
    const anchor = document.createElement("a");
    anchor.href = target;
    anchor.target = "_self";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  }
}

function getInitials(value: string | null | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "PH";
  return raw
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function isCommunityMember(community: CommunityRecord, profile: UserProfileType | null) {
  if (!profile) return false;

  const profileId = profile.id?.trim() || "";
  const profilePhone = normalizePhone(profile.phone);

  return community.members.some((member) => {
    const byId = Boolean(profileId && member.id && member.id === profileId);
    const byPhone = Boolean(profilePhone && member.phone && member.phone === profilePhone);
    return byId || byPhone;
  });
}

function findInviteCommunity(
  communities: CommunityRecord[],
  inviteCode: string | null,
  inviteLink: string | null,
) {
  const targetInviteCode = extractCommunityInviteCode(inviteCode || inviteLink || "") || "";
  if (!targetInviteCode) return null;

  return communities.find((community) => (
    extractCommunityInviteCode(community.inviteCode || community.inviteLink || "") === targetInviteCode
  )) ?? null;
}

export default function CommunityJoinPage({
  inviteCode,
  inviteLink,
  cabinetUrl = DEFAULT_CABINET_URL,
}: CommunityJoinPageProps) {
  const normalizedInviteCode = useMemo(
    () => extractCommunityInviteCode(inviteCode || inviteLink || "") || null,
    [inviteCode, inviteLink],
  );
  const normalizedInviteLink = useMemo(
    () => (inviteLink || "").trim() || buildCommunityInviteLink(normalizedInviteCode) || null,
    [inviteLink, normalizedInviteCode],
  );

  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [community, setCommunity] = useState<CommunityRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"join" | "decline" | null>(null);
  const [inviteLogoFallbackIndex, setInviteLogoFallbackIndex] = useState(0);
  const communityLogoCandidates = useMemo(
    () => buildCommunityLogoCandidates(community),
    [community],
  );

  useEffect(() => {
    setInviteLogoFallbackIndex(0);
  }, [communityLogoCandidates]);

  useEffect(() => {
    let cancelled = false;

    const loadInvitation = async () => {
      if (!normalizedInviteCode && !normalizedInviteLink) {
        setLoadError("Проверьте ссылку приглашения и попробуйте снова.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setLoadError(null);

      const profileResult = await apiFetchProfile();
      if (cancelled) return;

      if (profileResult.error || !profileResult.data) {
        setProfile(null);
        setLoadError(profileResult.error?.message || "Не удалось загрузить профиль.");
        setLoading(false);
        return;
      }

      setProfile(profileResult.data);

      const communitiesResult = await apiFetchCommunities({
        phone: profileResult.data.phone,
        clientId: profileResult.data.id,
      });
      if (cancelled) return;

      const matchedCommunity = findInviteCommunity(
        communitiesResult.data?.communities ?? [],
        normalizedInviteCode,
        normalizedInviteLink,
      );

      setCommunity(matchedCommunity);
      setLoading(false);
    };

    void loadInvitation();

    return () => {
      cancelled = true;
    };
  }, [normalizedInviteCode, normalizedInviteLink]);

  const alreadyMember = useMemo(
    () => (community ? isCommunityMember(community, profile) : false),
    [community, profile],
  );

  const statusLabel = useMemo(() => {
    if (alreadyMember) {
      return community
        ? `Вы уже состоите в сообществе «${community.name}».`
        : "Вы уже состоите в этом сообществе.";
    }

    if (community) {
      return `Подтвердите вступление в сообщество «${community.name}».`;
    }

    return "Подтвердите, что хотите перейти по приглашению в сообщество.";
  }, [alreadyMember, community]);

  const handleDecline = useCallback(() => {
    setActionError(null);
    setSubmitting("decline");

    if (redirectToCabinet(cabinetUrl)) {
      return;
    }

    setSubmitting(null);
    setActionError("Не удалось открыть личный кабинет.");
  }, [cabinetUrl]);

  const handleJoin = useCallback(async () => {
    if (!profile) {
      setActionError("Не удалось загрузить профиль для вступления.");
      return;
    }

    if (alreadyMember) {
      if (redirectToCabinet(cabinetUrl)) {
        return;
      }

      setActionError("Не удалось открыть личный кабинет.");
      return;
    }

    if (!normalizedInviteCode && !normalizedInviteLink) {
      setActionError("Ссылка приглашения повреждена.");
      return;
    }

    setActionError(null);
    setSubmitting("join");

    const response = await apiJoinCommunityByInvite({
      inviteCode: normalizedInviteCode,
      inviteLink: normalizedInviteLink,
      member: buildCommunityActor(profile),
    });

    if (response.error) {
      setSubmitting(null);
      setActionError(
        communityErrorMessage(response.error, "Не удалось вступить в сообщество."),
      );
      return;
    }

    if (response.data?.community) {
      setCommunity(response.data.community);
    }

    if (redirectToCabinet(cabinetUrl)) {
      return;
    }

    setSubmitting(null);
    setActionError("Вступление сохранено, но не удалось открыть личный кабинет.");
  }, [alreadyMember, cabinetUrl, normalizedInviteCode, normalizedInviteLink, profile]);

  if (loading) {
    return (
      <div className="app-container game-container">
        <div className="game-empty">Загружаем приглашение в сообщество...</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <div className="page-title">Приглашение в сообщество</div>
        </div>
        <div className="game-section">
          <div className="game-empty game-pay-error">{loadError}</div>
        </div>
        <div className="game-section">
          <button className="section-cta" type="button" onClick={handleDecline}>
            Перейти в личный кабинет
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container game-container game-join-container">
      <div className="page-header">
        <div className="page-title">Приглашение в сообщество</div>
      </div>

      <div className="game-section">
        <div className="details-card community-invite-card">
          <div className="community-invite-head">
            {communityLogoCandidates[inviteLogoFallbackIndex] ? (
              <img
                src={communityLogoCandidates[inviteLogoFallbackIndex]}
                alt={community?.name ?? "Сообщество"}
                className="community-invite-logo"
                onError={() => {
                  setInviteLogoFallbackIndex((current) => (
                    current < communityLogoCandidates.length ? current + 1 : current
                  ));
                }}
              />
            ) : (
              <div className="community-invite-logo community-invite-logo--fallback">
                {getInitials(community?.name)}
              </div>
            )}

            <div className="community-invite-copy">
              <div className="details-date">{community?.name || "Сообщество Padel HUB"}</div>
              <div className="details-time">
                {community
                  ? community.visibility === "OPEN"
                    ? "Открытое сообщество"
                    : "Закрытое сообщество"
                  : "Приглашение по ссылке"}
              </div>
              {community?.city && (
                <div className="details-time details-time-strong">{community.city}</div>
              )}
            </div>
          </div>

          {community?.description && (
            <div className="community-invite-description">{community.description}</div>
          )}

          <div className="details-tags community-invite-tags">
            {community?.minimumLevel && (
              <span className="game-created-tag">Уровень от {community.minimumLevel}</span>
            )}
            {community?.memberCount ? (
              <span className="game-created-tag game-created-tag-neutral">
                {community.memberCount} участников
              </span>
            ) : null}
            {normalizedInviteCode && (
              <span className="game-created-tag game-created-tag-duration">
                Код: {normalizedInviteCode}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="game-section">
        <div className="game-join-status">{statusLabel}</div>
        <div className="community-invite-note">
          После выбора откроется обычный личный кабинет.
        </div>
      </div>

      {actionError && (
        <div className="game-section">
          <div className="game-empty game-pay-error">{actionError}</div>
        </div>
      )}

      <div className="game-section game-join-actions">
        <button
          className="section-cta"
          type="button"
          disabled={Boolean(submitting)}
          onClick={() => {
            void handleJoin();
          }}
        >
          {submitting === "join"
            ? "Сохраняем..."
            : alreadyMember
              ? "Перейти в личный кабинет"
              : "Вступить в сообщество"}
        </button>

        <button
          className="section-cta section-cta-secondary"
          type="button"
          disabled={Boolean(submitting)}
          onClick={handleDecline}
        >
          {submitting === "decline" ? "Переходим..." : "Отказаться"}
        </button>
      </div>
    </div>
  );
}

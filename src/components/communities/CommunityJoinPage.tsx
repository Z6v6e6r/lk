import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CABINET_URL } from "../../consts/api_config";
import {
  apiFetchCommunities,
  apiJoinCommunityByInvite,
  buildCommunityInviteLink,
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
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import { buildCommunityCabinetUrl } from "../../utils/communityJoinRoute";
import { AuthForm } from "../auth/AuthForm";
import { useAuth } from "../../context/authShared";
import { CommunityInviteView, type CommunityInviteState } from "./CommunityInviteView";

interface CommunityJoinPageProps {
  inviteCode?: string | null;
  inviteLink?: string | null;
  cabinetUrl?: string | null;
  authenticated?: boolean;
  onLogin?: () => void;
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
  if (!raw) return fallback ? appendCurrentAuthModeToNavigableUrl(fallback).toString() : fallback;

  try {
    return appendCurrentAuthModeToNavigableUrl(
      new URL(raw, typeof window !== "undefined" ? window.location.origin : undefined),
    ).toString();
  } catch {
    return raw || (fallback ? appendCurrentAuthModeToNavigableUrl(fallback).toString() : fallback);
  }
}

function redirectToCabinet(urlValue: string | null | undefined, communityId?: string) {
  if (typeof window === "undefined") return false;

  let target = resolveInviteCabinetUrl(urlValue);
  if (!target) return false;
  if (communityId) {
    try { target = buildCommunityCabinetUrl(target, communityId); }
    catch { return false; }
  }

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


function isCommunityMember(community: CommunityRecord, profile: UserProfileType | null, status: "ACTIVE" | "PENDING" = "ACTIVE") {
  if (!profile) return false;

  const profileId = profile.id?.trim() || "";
  const profilePhone = normalizePhone(profile.phone);

  return community.members.some((member) => {
    if (member.status !== status) return false;
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
  authenticated = true,
  onLogin = () => {},
}: CommunityJoinPageProps) {
  const { logout } = useAuth();
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
  const [state, setState] = useState<CommunityInviteState>("checking");
  const [showLogin, setShowLogin] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"join" | "decline" | "reload" | null>(null);
  const context = useMemo(() => ({ normalizedInviteCode, normalizedInviteLink, authenticated }), [normalizedInviteCode, normalizedInviteLink, authenticated]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const mounted = useRef(false);
  const activeAction = useRef(false);
  const [loadedContext, setLoadedContext] = useState<typeof context | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const requireLogin = useCallback(() => {
    setProfile(null); setCommunity(null); setState("guest");
    setLoadError(null); setActionError(null); setShowLogin(false);
    setLoadedContext(context);
  }, [context]);

  const reload = useCallback(async (fresh = false, isCurrent: () => boolean = () => true) => {
    const valid = () => mounted.current && currentContext.current === context && isCurrent();
    if (!authenticated) {
      if (valid()) { setProfile(null); setCommunity(null); setState("guest"); setLoading(false); setLoadedContext(context); }
      return;
    }
    setLoading(true); setLoadError(null); setActionError(null);
    try {
      if (!normalizedInviteCode && !normalizedInviteLink) throw new Error("INVITE_MISSING");
      const profileResult = await apiFetchProfile();
      if (!valid()) return;
      if (profileResult.status === 401) { requireLogin(); return; }
      if (profileResult.error || !profileResult.data) throw new Error("PROFILE_UNAVAILABLE");
      const communitiesResult = await apiFetchCommunities({ phone: profileResult.data.phone, clientId: profileResult.data.id, forceFresh: fresh });
      if (!valid()) return;
      if (communitiesResult.status === 401) { requireLogin(); return; }
      if (communitiesResult.error) throw new Error("COMMUNITIES_UNAVAILABLE");
      const found = findInviteCommunity(communitiesResult.data?.communities ?? [], normalizedInviteCode, normalizedInviteLink);
      // Absence from a scoped list cannot prove a previously ambiguous join failed.
      if (fresh && !found) throw new Error("MEMBERSHIP_UNKNOWN");
      setProfile(profileResult.data); setCommunity(found);
      const member = found && isCommunityMember(found, profileResult.data);
      const pending = found && isCommunityMember(found, profileResult.data, "PENDING");
      // This summary proves membership, not eligibility to join. The command remains authoritative.
      setState(previous => member ? "member" : pending || previous === "pending" ? "pending" : "unverified");
      setLoadedContext(context);
    } catch {
      if (!valid()) return;
      setState("error"); setLoadError("Не удалось проверить приглашение. Проверьте статус ещё раз."); setLoadedContext(context);
    } finally { if (valid()) setLoading(false); }
  }, [authenticated, context, normalizedInviteCode, normalizedInviteLink, requireLogin]);

  useEffect(() => {
    let cancelled = false;
    setState("checking"); setCommunity(null); setProfile(null);
    void reload(false, () => !cancelled);
    return () => { cancelled = true; };
  }, [reload]);
  useEffect(() => setShowLogin(false), [normalizedInviteCode, normalizedInviteLink]);

  const alreadyMember = useMemo(
    () => (community ? isCommunityMember(community, profile) : false),
    [community, profile],
  );

  const handleDecline = useCallback(() => {
    if (activeAction.current) return;
    activeAction.current = true;
    setActionError(null);
    setSubmitting("decline");

    if (redirectToCabinet(cabinetUrl)) {
      return;
    }

    setSubmitting(null);
    setActionError("Не удалось открыть личный кабинет.");
    activeAction.current = false;
  }, [cabinetUrl]);

  const handleJoin = useCallback(async () => {
    if (activeAction.current || loading || loadedContext !== context) return;
    if (!profile) {
      setActionError("Не удалось загрузить профиль для вступления.");
      return;
    }

    if (alreadyMember) {
      activeAction.current = true;
      setSubmitting("join");
      if (community && redirectToCabinet(cabinetUrl, community.id)) {
        return;
      }

      activeAction.current = false; setSubmitting(null);
      setActionError("Не удалось открыть сообщество.");
      return;
    }

    if (state !== "unverified" || (!normalizedInviteCode && !normalizedInviteLink)) {
      setActionError("Ссылка приглашения повреждена.");
      return;
    }

    setActionError(null);
    setSubmitting("join");
    activeAction.current = true;
    try {
      const response = await apiJoinCommunityByInvite({ inviteCode: normalizedInviteCode, inviteLink: normalizedInviteLink, member: buildCommunityActor(profile) }, { allowFallback: false });
      if (!mounted.current || currentContext.current !== context) return;
      if (response.status === 401) { requireLogin(); return; }
      if (response.error) {
        if (response.status != null && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
          setState("blocked"); setActionError(communityErrorMessage(response.error, "Не удалось вступить в сообщество."));
          return;
        }
        throw new Error("JOIN_OUTCOME_UNKNOWN");
      }
      const confirmed = response.data?.community;
      if (!confirmed || (community && confirmed.id !== community.id) || !findInviteCommunity([confirmed], normalizedInviteCode, normalizedInviteLink)) throw new Error("JOIN_SCOPE_UNKNOWN");
      setCommunity(confirmed);
      if (isCommunityMember(confirmed, profile)) { setState("member"); return; }
      if (isCommunityMember(confirmed, profile, "PENDING") || response.data?.membershipStatus === "PENDING") { setState("pending"); return; }
      throw new Error("MEMBERSHIP_UNCONFIRMED");
    } catch {
      if (mounted.current && currentContext.current === context) {
        setState("error"); setActionError("Не удалось подтвердить вступление. Сначала проверьте статус.");
      }
    } finally {
      activeAction.current = false;
      if (mounted.current) setSubmitting(null);
    }
  }, [alreadyMember, cabinetUrl, community, context, loadedContext, loading, normalizedInviteCode, normalizedInviteLink, profile, state, requireLogin]);

  const handleReload = async () => {
    if (activeAction.current) return;
    activeAction.current = true; setSubmitting("reload");
    try { await reload(true); }
    finally { activeAction.current = false; if (mounted.current) setSubmitting(null); }
  };

  const current = loadedContext === context;
  const visibleState = !current || loading ? "checking" : state;
  const primary = visibleState === "guest" ? () => { if (authenticated) logout(); setShowLogin(true); }
    : visibleState === "error" || visibleState === "pending" ? () => { void handleReload(); }
    : () => { void handleJoin(); };
  return <CommunityInviteView state={visibleState} community={current ? community : null}
    busy={Boolean(submitting) || loading}
    busyLabel={submitting === "join" ? alreadyMember ? "Открываем…" : "Вступаем…" : submitting === "decline" ? "Переходим…" : "Проверяем…"}
    error={current ? actionError || loadError : null} reason={actionError}
    onPrimary={primary} onSecondary={handleDecline}>
    {visibleState === "guest" && showLogin ? <AuthForm onLogin={onLogin} /> : null}
  </CommunityInviteView>;
}

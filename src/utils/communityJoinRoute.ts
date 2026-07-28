export type CommunityJoinRouteConfig = {
  inviteCode?: string | null;
  inviteLink?: string | null;
  cabinetUrl?: string | null;
};

export type CommunityJoinRouteData = {
  enabled: boolean;
  inviteCode: string | null;
  inviteLink: string | null;
  cabinetUrl: string;
};

function normalizeInviteCabinetUrl(value: string | null | undefined, fallback: string) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  try {
    return new URL(raw, fallback || undefined).toString();
  } catch {
    return raw || fallback;
  }
}

function extractCommunityInviteCode(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw, "https://padlhub.ru");
    return (
      parsed.searchParams.get("invite")
      || parsed.searchParams.get("code")
      || parsed.searchParams.get("inviteCode")
      || parsed.pathname.split("/").filter(Boolean).at(-1)
      || ""
    ).trim() || null;
  } catch {
    return raw.split("/").filter(Boolean).at(-1)?.trim() || null;
  }
}

export function resolveCommunityJoinRouteData(params: {
  href: string;
  defaultCabinetUrl: string;
  defaultCommunityJoinPath: string;
  config?: CommunityJoinRouteConfig | null;
}) : CommunityJoinRouteData {
  const current = new URL(params.href, "https://padlhub.ru");
  const hashRaw = (current.hash || "").replace(/^#/, "");
  const hashQueryIndex = hashRaw.indexOf("?");
  const hashParams = new URLSearchParams(hashQueryIndex >= 0 ? hashRaw.slice(hashQueryIndex + 1) : "");
  const communityJoinConfig = params.config ?? null;
  const byPath = current.pathname.replace(/\/+$/, "").endsWith(params.defaultCommunityJoinPath)
    || current.pathname.includes("/community/invite/");

  const inviteLink = (
    current.searchParams.get("inviteLink")
    || current.searchParams.get("invite")
    || hashParams.get("inviteLink")
    || hashParams.get("invite")
    || communityJoinConfig?.inviteLink
    || ""
  ).trim();

  const inviteCode = (
    current.searchParams.get("inviteCode")
    || current.searchParams.get("invite")
    || hashParams.get("inviteCode")
    || hashParams.get("invite")
    || current.searchParams.get("communityInvite")
    || hashParams.get("communityInvite")
    || communityJoinConfig?.inviteCode
    || extractCommunityInviteCode(current.pathname.includes("/community/invite/") ? current.pathname : inviteLink)
    || (byPath ? (current.searchParams.get("code") || hashParams.get("code") || "") : "")
    || ""
  ).trim();

  return {
    enabled: byPath || Boolean(inviteCode),
    inviteCode: inviteCode || null,
    inviteLink: inviteLink || null,
    cabinetUrl: normalizeInviteCabinetUrl(
      current.searchParams.get("cabinetUrl")
      || current.searchParams.get("returnUrl")
      || communityJoinConfig?.cabinetUrl
      || params.defaultCabinetUrl,
      params.defaultCabinetUrl,
    ),
  };
}

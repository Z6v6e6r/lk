import {
  apiFetchProfile,
  apiUpdatePadelGameRecord,
  type PadelGameRecord,
  type UserProfileType,
} from "./apiClient";
import {
  apiCreateCommunityFeedPost,
  apiFetchCommunities,
  type CommunityActorPayload,
  type CommunityRecord,
} from "./communityApi";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "./customFields";

const inFlightAutopublishGameIds = new Set<string>();
const RATING_LABELS = ["D", "D+", "C", "C+", "B", "B+", "A"] as const;

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePhoneForGame(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function detectPaidStateByStatusToken(value: string | null | undefined): boolean | null {
  const token = String(value || "").trim().toUpperCase();
  if (!token) return null;

  const negativeMarkers = ["CANCEL", "FAIL", "ERROR", "DECLIN", "REFUND", "EXPIRE", "VOID"];
  if (negativeMarkers.some((marker) => token.includes(marker))) {
    return false;
  }

  const paidMarkers = [
    "PAID",
    "PAYED",
    "SUCCESS",
    "SUCCEEDED",
    "CAPTURED",
    "COMPLETED",
    "DONE",
    "CONFIRMED",
    "APPROVED",
  ];
  if (paidMarkers.some((marker) => token.includes(marker))) {
    return true;
  }

  return null;
}

function isGamePaidForCommunityAutopublish(game: PadelGameRecord | null | undefined): boolean {
  if (!game) return false;
  if (game.payment?.paid === true) return true;
  return detectPaidStateByStatusToken(game.status) === true;
}

function getCommunityAutopublishPayload(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  if (isRecordObject(metadata.communityAutoPublish)) return metadata.communityAutoPublish;
  if (isRecordObject(metadata.communityAutoPublishDev)) return metadata.communityAutoPublishDev;
  return null;
}

function buildCommunityAutopublishMetadataFields(
  payload: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!payload) return {};
  return {
    communityAutoPublish: payload,
    communityAutoPublishDev: payload,
  };
}

function extractGameCustomTitle(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const value = typeof metadata.gameTitle === "string" ? metadata.gameTitle.trim() : "";
  return value || null;
}

function extractGameParticipantComment(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const value = typeof metadata.participantComment === "string" ? metadata.participantComment.trim() : "";
  return value || null;
}

function extractGameJoinPrice(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  if (typeof metadata.joinPrice === "number" && Number.isFinite(metadata.joinPrice)) {
    const normalized = Math.max(0, Math.round(metadata.joinPrice));
    return normalized > 0 ? String(normalized) : null;
  }
  const raw = typeof metadata.joinPrice === "string" ? metadata.joinPrice.trim() : "";
  const digits = raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
  return digits || null;
}

function formatPrice(value: number): string {
  return value.toLocaleString("ru-RU");
}

function formatGameJoinPriceLabel(value: string | null): string | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return `${formatPrice(parsed)} ₽`;
}

function extractCommunityAutopublishSelectionState(
  metadata: Record<string, unknown> | null | undefined,
): {
  selectedCommunityIds: string[];
  stationCommunityId: string | null;
  selectionTouched: boolean;
} {
  const payload = getCommunityAutopublishPayload(metadata);
  if (!payload) {
    return {
      selectedCommunityIds: [],
      stationCommunityId: null,
      selectionTouched: false,
    };
  }

  const selectedCommunityIds = Array.isArray(payload.selectedCommunityIds)
    ? Array.from(new Set(
        payload.selectedCommunityIds
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean),
      ))
    : [];
  const stationCommunityId = typeof payload.stationCommunityId === "string"
    ? payload.stationCommunityId.trim() || null
    : null;
  const selectionTouched = typeof payload.selectionTouched === "boolean"
    ? payload.selectionTouched
    : selectedCommunityIds.length > 0;

  return {
    selectedCommunityIds,
    stationCommunityId,
    selectionTouched,
  };
}

function extractCommunityAutopublishPostsMap(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const payload = getCommunityAutopublishPayload(metadata);
  if (!payload || !isRecordObject(payload.posts)) {
    return {};
  }

  const next: Record<string, string> = {};
  Object.entries(payload.posts).forEach(([communityId, postId]) => {
    const normalizedCommunityId = communityId.trim();
    const normalizedPostId = typeof postId === "string" ? postId.trim() : "";
    if (!normalizedCommunityId || !normalizedPostId) return;
    next[normalizedCommunityId] = normalizedPostId;
  });
  return next;
}

export function getGameCommunityAutopublishState(
  record: PadelGameRecord | null | undefined,
): {
  selectedCommunityIds: string[];
  stationCommunityId: string | null;
  selectionTouched: boolean;
  postsByCommunityId: Record<string, string>;
} {
  const metadata = isRecordObject(record?.metadata) ? record.metadata : null;
  const selectionState = extractCommunityAutopublishSelectionState(metadata);
  return {
    ...selectionState,
    postsByCommunityId: extractCommunityAutopublishPostsMap(metadata),
  };
}

function extractCommunityAutopublishSavedCommunities(
  metadata: Record<string, unknown> | null | undefined,
): Array<{
  communityId: string;
  communityName: string;
  postId: string | null;
  status: string;
  error: string | null;
}> {
  const payload = getCommunityAutopublishPayload(metadata);
  if (!payload || !Array.isArray(payload.communities)) {
    return [];
  }

  return payload.communities
    .map((value) => {
      if (!isRecordObject(value)) return null;
      const communityId = typeof value.communityId === "string" ? value.communityId.trim() : "";
      const communityName = typeof value.communityName === "string" ? value.communityName.trim() : "";
      if (!communityId) return null;

      return {
        communityId,
        communityName: communityName || communityId,
        postId: typeof value.postId === "string" ? value.postId.trim() || null : null,
        status: typeof value.status === "string" ? value.status.trim().toUpperCase() : "PENDING",
        error: typeof value.error === "string" ? value.error.trim() || null : null,
      };
    })
    .filter((value): value is {
      communityId: string;
      communityName: string;
      postId: string | null;
      status: string;
      error: string | null;
    } => Boolean(value));
}

function buildCommunityGamePostBody(game: PadelGameRecord): string {
  const metadata = isRecordObject(game.metadata) ? game.metadata : null;
  const participantComment = extractGameParticipantComment(metadata);
  const joinPriceLabel = formatGameJoinPriceLabel(extractGameJoinPrice(metadata));
  const date = game.booking?.date
    ? new Date(`${game.booking.date}T00:00:00`).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "long",
      })
    : "ближайшая дата";
  const timeFrom = game.booking?.timeFrom ?? "—:—";
  const timeTo = game.booking?.timeTo ?? "—:—";
  const location = [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(", ");
  return [
    [date, `${timeFrom} - ${timeTo}`, location].filter(Boolean).join(" • "),
    joinPriceLabel ? `Стоимость присоединения: ${joinPriceLabel}` : null,
    participantComment ? `Комментарий: ${participantComment}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCommunityGamePreviewLabel(game: PadelGameRecord): string {
  return [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(" • ") || "Матч сообщества";
}

function getCommunityActorLevelScore(
  numericRating: number | null,
  letterGrade: string | null | undefined,
): number {
  if (typeof numericRating === "number" && Number.isFinite(numericRating)) {
    return Math.max(1.5, Math.min(6, numericRating));
  }

  const normalizedGrade = String(letterGrade || "").trim().toUpperCase();
  const matchedIndex = RATING_LABELS.findIndex((item) => item === normalizedGrade);
  if (matchedIndex >= 0) {
    return matchedIndex + 1.5;
  }

  return 3.2;
}

function buildCommunityActor(
  profile: UserProfileType | null,
  fallbackGame: PadelGameRecord,
): CommunityActorPayload {
  if (profile) {
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim() || "Игрок";
    const explicitGrade = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel) ?? null;
    const numericValue = parseNumericLevel(
      getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric),
    );
    const levelScore = getCommunityActorLevelScore(numericValue, explicitGrade);

    return {
      id: profile.id ?? null,
      phone: profile.phone ?? null,
      name: fullName,
      avatar: profile.photo ?? null,
      role: "MEMBER",
      levelScore,
      levelLabel: explicitGrade ?? getLetterGrade(levelScore),
    };
  }

  const fallbackNumeric = fallbackGame.organizer?.ratingNumeric ?? null;
  const fallbackGrade = fallbackGame.organizer?.rating ?? null;
  const fallbackLevelScore = getCommunityActorLevelScore(fallbackNumeric, fallbackGrade);
  return {
    id: fallbackGame.organizer?.id ?? null,
    phone: fallbackGame.organizer?.phone ?? null,
    name: fallbackGame.organizer?.name || "Игрок",
    avatar: fallbackGame.organizer?.photo ?? null,
    role: "MEMBER",
    levelScore: fallbackLevelScore,
    levelLabel: fallbackGrade || getLetterGrade(fallbackLevelScore),
  };
}

async function resolveCommunityActor(game: PadelGameRecord): Promise<CommunityActorPayload> {
  const profileResult = await apiFetchProfile();
  return buildCommunityActor(profileResult.data ?? null, game);
}

function getCommunityName(
  communityId: string,
  communitiesById: Map<string, CommunityRecord>,
  savedCommunitiesById: Map<string, {
    communityId: string;
    communityName: string;
    postId: string | null;
    status: string;
    error: string | null;
  }>,
): string {
  return communitiesById.get(communityId)?.name
    ?? savedCommunitiesById.get(communityId)?.communityName
    ?? communityId;
}

function shouldAutopublishGame(record: PadelGameRecord | null | undefined): record is PadelGameRecord {
  if (!record?.id) return false;
  if (String(record.status || "").trim().toUpperCase().includes("CANCEL")) return false;
  if (!isGamePaidForCommunityAutopublish(record)) return false;

  const metadata = isRecordObject(record.metadata) ? record.metadata : null;
  const selectionState = extractCommunityAutopublishSelectionState(metadata);
  if (selectionState.selectedCommunityIds.length === 0) return false;
  const postsMap = extractCommunityAutopublishPostsMap(metadata);
  return selectionState.selectedCommunityIds.some((communityId) => !postsMap[communityId]);
}

async function syncSingleGameCommunityAutopublish(
  record: PadelGameRecord,
  actor: CommunityActorPayload,
  communitiesById: Map<string, CommunityRecord>,
): Promise<void> {
  const baseMetadata = isRecordObject(record.metadata) ? { ...record.metadata } : {};
  const payload = getCommunityAutopublishPayload(baseMetadata) ?? {};
  const selectionState = extractCommunityAutopublishSelectionState(baseMetadata);
  const selectedCommunityIds = selectionState.selectedCommunityIds;
  if (selectedCommunityIds.length === 0) return;

  const existingPostsByCommunityId = extractCommunityAutopublishPostsMap(baseMetadata);
  const pendingCommunityIds = selectedCommunityIds.filter((communityId) => !existingPostsByCommunityId[communityId]);
  if (pendingCommunityIds.length === 0) return;

  const savedCommunities = extractCommunityAutopublishSavedCommunities(baseMetadata);
  const savedCommunitiesById = new Map(savedCommunities.map((entry) => [entry.communityId, entry] as const));
  const nextEntries = new Map(savedCommunities.map((entry) => [entry.communityId, { ...entry }] as const));

  selectedCommunityIds.forEach((communityId) => {
    const existingEntry = nextEntries.get(communityId);
    const postId = existingPostsByCommunityId[communityId] ?? existingEntry?.postId ?? null;
    nextEntries.set(communityId, {
      communityId,
      communityName: getCommunityName(communityId, communitiesById, savedCommunitiesById),
      postId,
      status: postId ? "PUBLISHED" : (existingEntry?.status ?? "PENDING"),
      error: postId ? null : (existingEntry?.error ?? null),
    });
  });

  for (const communityId of pendingCommunityIds) {
    const response = await apiCreateCommunityFeedPost(communityId, {
      member: actor,
      kind: "GAME",
      title: extractGameCustomTitle(isRecordObject(record.metadata) ? record.metadata : null) ?? "Приглашение в игру",
      body: buildCommunityGamePostBody(record),
      imageUrl: null,
      previewLabel: buildCommunityGamePreviewLabel(record),
      ctaLabel: "Открыть игру",
      relatedGameId: record.id,
      relatedTournamentId: null,
    });

    const communityName = getCommunityName(communityId, communitiesById, savedCommunitiesById);
    if (response.data?.id) {
      existingPostsByCommunityId[communityId] = response.data.id;
      nextEntries.set(communityId, {
        communityId,
        communityName,
        postId: response.data.id,
        status: "PUBLISHED",
        error: null,
      });
      continue;
    }

    nextEntries.set(communityId, {
      communityId,
      communityName,
      postId: null,
      status: "FAILED",
      error: response.error?.message ?? "Не удалось опубликовать игру в ленте сообщества",
    });
  }

  const nextPayload = {
    ...payload,
    enabled: true,
    mode: typeof payload.mode === "string" ? payload.mode : "selected_communities",
    lastAttemptAt: new Date().toISOString(),
    selectionTouched: selectionState.selectionTouched,
    stationCommunityId: selectionState.stationCommunityId,
    selectedCommunityIds,
    posts: existingPostsByCommunityId,
    communities: selectedCommunityIds.map((communityId) => (
      nextEntries.get(communityId) ?? {
        communityId,
        communityName: getCommunityName(communityId, communitiesById, savedCommunitiesById),
        postId: existingPostsByCommunityId[communityId] ?? null,
        status: existingPostsByCommunityId[communityId] ? "PUBLISHED" : "PENDING",
        error: null,
      }
    )),
  };

  const nextMetadata = {
    ...baseMetadata,
    ...buildCommunityAutopublishMetadataFields(nextPayload),
  };

  await apiUpdatePadelGameRecord(record.id, {
    metadata: nextMetadata,
  });
}

export async function syncGamesCommunityAutopublish(
  records: Array<PadelGameRecord | null | undefined>,
): Promise<void> {
  const eligibleRecords = Array.from(new Map(
    records
      .filter(shouldAutopublishGame)
      .map((record) => [record.id, record] as const),
  ).values()).filter((record) => {
    if (inFlightAutopublishGameIds.has(record.id)) return false;
    inFlightAutopublishGameIds.add(record.id);
    return true;
  });

  if (eligibleRecords.length === 0) return;

  try {
    const actor = await resolveCommunityActor(eligibleRecords[0]);
    const normalizedPhone = normalizePhoneForGame(actor.phone ?? null);
    const communitiesResult = (
      actor.id || normalizedPhone
        ? await apiFetchCommunities({
            clientId: actor.id ?? null,
            phone: normalizedPhone,
            forceFresh: true,
          })
        : null
    );
    const communitiesById = new Map(
      (communitiesResult?.data?.communities ?? []).map((community) => [community.id, community] as const),
    );

    for (const record of eligibleRecords) {
      await syncSingleGameCommunityAutopublish(record, actor, communitiesById);
    }
  } finally {
    eligibleRecords.forEach((record) => {
      inFlightAutopublishGameIds.delete(record.id);
    });
  }
}

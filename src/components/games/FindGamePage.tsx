import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiFetchPadelAvailableGames,
  apiFetchProfile,
  type PadelGamePlayer,
  type PadelGameRecord,
  type UserProfileType,
} from "../../utils/apiClient";
import { CABINET_URL, PUBLIC_GAME_CREATE_PATH, PUBLIC_INVITE_PATH } from "../../consts/api_config";
import { CUSTOM_FIELD_IDS, getCustomFieldValue, getLetterGrade, parseNumericLevel } from "../../utils/customFields";
import { addGameToCalendar } from "../../utils/calendarEvent";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";

interface FindGamePageProps {
  onBack?: () => void;
  cabinetUrl?: string | null;
  presetStudioId?: string | null;
  presetStudioName?: string | null;
}

type ViewerGameState = "participant" | "waitlist" | "none";

const PAGE_SIZE = 12;
const DEFAULT_CABINET_URL = CABINET_URL;
const DEFAULT_GAME_CREATE_PATH =
  (PUBLIC_GAME_CREATE_PATH || "/game_create").replace(/\/+$/, "") || "/game_create";
const DEFAULT_GAME_JOIN_PATH =
  (PUBLIC_INVITE_PATH || "/game_join").replace(/\/+$/, "") || "/game_join";

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function initialsFromName(value: string | null | undefined): string {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const initials = parts.map((part) => part[0]?.toUpperCase()).join("");
  return initials || "PH";
}

function parseLocalGameDate(dateValue: string | null | undefined): Date | null {
  if (!dateValue) return null;
  const parsed = new Date(`${dateValue}T00:00:00`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function resolveGameStartTs(game: PadelGameRecord): number | null {
  const booking = game.booking;
  const date = booking?.date;
  const time = booking?.timeFrom || booking?.timeTo;
  if (!date || !time) return null;
  const normalizedTime = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
  const parsed = new Date(`${date}T${normalizedTime}`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function resolveGameEndTs(game: PadelGameRecord): number | null {
  const booking = game.booking;
  const date = booking?.date;
  const time = booking?.timeTo || booking?.timeFrom;
  if (!date || !time) return null;
  const normalizedTime = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
  const parsed = new Date(`${date}T${normalizedTime}`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function isGameCancelled(game: PadelGameRecord): boolean {
  return String(game.status || "").trim().toUpperCase().includes("CANCEL");
}

function isGamePendingPayment(game: PadelGameRecord): boolean {
  const status = String(game.status || "").trim().toUpperCase();
  return status.includes("PAYMENT_PENDING") || status.includes("DRAFT") || game.payment?.paid === false;
}

function resolveMaxPlayers(game: PadelGameRecord): number {
  const inviteLimit = game.invite?.maxPlayers;
  if (typeof inviteLimit === "number" && Number.isFinite(inviteLimit) && inviteLimit > 0) {
    return Math.floor(inviteLimit);
  }

  const metadata = game.metadata;
  if (isRecordObject(metadata)) {
    const fromMeta = toNumber(metadata.maxPlayers ?? metadata.playersLimit);
    if (fromMeta !== null && fromMeta > 0) return Math.floor(fromMeta);

    const format = String(metadata.gameFormat || metadata.format || "").trim().toLowerCase();
    if (format === "singles" || format.includes("1x1") || format.includes("1 на 1")) return 2;
  }

  return 4;
}

function resolveWaitlistEnabled(game: PadelGameRecord): boolean {
  if (typeof game.invite?.waitlistEnabled === "boolean") return game.invite.waitlistEnabled;
  const metadata = game.metadata;
  if (isRecordObject(metadata) && typeof metadata.waitlistEnabled === "boolean") {
    return metadata.waitlistEnabled;
  }
  return true;
}

function getPlayerKey(player: PadelGamePlayer, index: number): string {
  const phone = normalizePhone(player.phone);
  if (phone) return `phone:${phone}`;
  if (player.id) return `id:${player.id}`;
  return `idx:${index}`;
}

function isSamePlayer(player: PadelGamePlayer, viewer: { id: string | null; phone: string | null }): boolean {
  const playerPhone = normalizePhone(player.phone);
  return Boolean(
    (viewer.phone && playerPhone && playerPhone === viewer.phone) ||
    (viewer.id && player.id && player.id === viewer.id),
  );
}

function resolveViewerState(
  game: PadelGameRecord,
  viewer: { id: string | null; phone: string | null },
): ViewerGameState {
  if ((game.participants ?? []).some((player) => isSamePlayer(player, viewer))) return "participant";
  if ((game.waitlist ?? []).some((player) => isSamePlayer(player, viewer))) return "waitlist";
  return "none";
}

function getViewerLevel(profile: UserProfileType | null): string | null {
  if (!profile) return null;
  const explicitGrade = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel);
  if (explicitGrade) return explicitGrade;
  const numeric = parseNumericLevel(getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric));
  return numeric !== null ? getLetterGrade(numeric) : null;
}

function getRatingTag(game: PadelGameRecord): string {
  if (game.settings?.ratingGame === false) return "Без рейтинга";
  const min = game.settings?.minRating;
  const max = game.settings?.maxRating;
  if (min && max) return `${min}-${max}`;
  if (min) return `от ${min}`;
  if (max) return `до ${max}`;
  return "Рейтинг";
}

function getGameFormatLabel(maxPlayers: number): string {
  return maxPlayers <= 2 ? "1 на 1" : "2 на 2";
}

function formatDateLine(game: PadelGameRecord): string {
  const parsed = parseLocalGameDate(game.booking?.date);
  if (!parsed) return "Дата уточняется";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function getDateBadgeLabels(game: PadelGameRecord) {
  const parsed = parseLocalGameDate(game.booking?.date);
  if (!parsed) {
    return {
      monthLabel: "ИГРА",
      dayLabel: "—",
      weekdayLabel: "—",
    };
  }

  return {
    monthLabel: parsed
      .toLocaleDateString("ru-RU", { month: "short" })
      .replace(".", "")
      .trim()
      .slice(0, 3)
      .toUpperCase(),
    dayLabel: parsed.toLocaleDateString("ru-RU", { day: "2-digit" }),
    weekdayLabel: parsed
      .toLocaleDateString("ru-RU", { weekday: "short" })
      .replace(".", "")
      .toUpperCase(),
  };
}

function formatTimeLine(game: PadelGameRecord): string {
  const from = game.booking?.timeFrom;
  const to = game.booking?.timeTo;
  if (from && to) return `${from} - ${to}`;
  if (from) return from;
  if (to) return `до ${to}`;
  return "Время уточняется";
}

function formatLocationLine(game: PadelGameRecord): string {
  return [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(" · ") || "Станция уточняется";
}

function normalizeComparable(value: string | null | undefined): string | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function matchesStationFilter(
  game: PadelGameRecord,
  presetStudioId: string | null | undefined,
  presetStudioName: string | null | undefined,
): boolean {
  const studioId = String(presetStudioId || "").trim();
  const studioName = normalizeComparable(presetStudioName);
  if (!studioId && !studioName) return true;

  if (studioId && game.booking?.studioId === studioId) return true;
  if (!studioName) return false;

  const gameStudioName = normalizeComparable(game.booking?.studioName);
  return Boolean(gameStudioName && (gameStudioName.includes(studioName) || studioName.includes(gameStudioName)));
}

function buildAbsolutePageUrl(path: string, fallbackOrigin?: string): URL {
  if (typeof window === "undefined") {
    return new URL(path, fallbackOrigin || "https://padlhub.ru");
  }
  return new URL(path, window.location.origin);
}

function normalizeUrl(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw, typeof window !== "undefined" ? window.location.origin : "https://padlhub.ru").toString();
  } catch {
    return raw;
  }
}

function mergeGames(current: PadelGameRecord[], incoming: PadelGameRecord[]): PadelGameRecord[] {
  const byId = new Map<string, PadelGameRecord>();
  current.forEach((game) => byId.set(game.id, game));
  incoming.forEach((game) => byId.set(game.id, game));
  return Array.from(byId.values()).sort((left, right) => {
    const leftTs = resolveGameStartTs(left) ?? Number.MAX_SAFE_INTEGER;
    const rightTs = resolveGameStartTs(right) ?? Number.MAX_SAFE_INTEGER;
    return leftTs - rightTs;
  });
}

function isJoinablePublicGame(
  game: PadelGameRecord,
  viewer: { id: string | null; phone: string | null },
): boolean {
  if (!game.id || isGameCancelled(game) || isGamePendingPayment(game)) return false;
  if (game.settings?.isPrivate === true) return false;

  const endTs = resolveGameEndTs(game);
  if (endTs !== null && endTs < Date.now()) return false;

  const maxPlayers = resolveMaxPlayers(game);
  const participantCount = game.participants?.length ?? 0;
  const viewerState = resolveViewerState(game, viewer);
  if (viewerState !== "none") return true;

  return participantCount < maxPlayers || resolveWaitlistEnabled(game);
}

function GamePlayerAvatar({ player, index }: { player: PadelGamePlayer; index: number }) {
  const level = player.rating || (typeof player.ratingNumeric === "number" ? getLetterGrade(player.ratingNumeric) : null);
  const numeric = typeof player.ratingNumeric === "number" ? player.ratingNumeric : null;
  const progress = numeric !== null
    ? `${Math.max(18, Math.min(360, (numeric / 7) * 360))}deg`
    : "0deg";

  return (
    <div className="find-game-player" title={player.name || `Игрок ${index + 1}`}>
      <span
        className={`find-game-player-ring${numeric !== null ? " has-level" : ""}`}
        style={{ "--player-ring-progress": progress } as CSSProperties}
      >
        {player.photo ? (
          <img className="find-game-player-avatar" src={player.photo} alt="" />
        ) : (
          <span className="find-game-player-avatar find-game-player-fallback">
            {initialsFromName(player.name)}
          </span>
        )}
      </span>
      {level && <span className="find-game-player-level">{level}</span>}
    </div>
  );
}

function EmptyPlayerSlot() {
  return (
    <div className="find-game-player find-game-player-empty">
      <span className="find-game-player-ring">
        <span className="find-game-player-avatar find-game-player-fallback">+</span>
      </span>
    </div>
  );
}

function FindGameCard({
  game,
  viewer,
  onOpen,
}: {
  game: PadelGameRecord;
  viewer: { id: string | null; phone: string | null; level: string | null };
  onOpen: (game: PadelGameRecord) => void;
}) {
  const maxPlayers = resolveMaxPlayers(game);
  const participants = (game.participants ?? []).slice(0, maxPlayers);
  const freeSlots = Math.max(0, maxPlayers - participants.length);
  const viewerState = resolveViewerState(game, viewer);
  const waitlistEnabled = resolveWaitlistEnabled(game);
  const badgeLabels = getDateBadgeLabels(game);
  const actionLabel = viewerState === "participant"
    ? "Открыть игру"
    : viewerState === "waitlist"
      ? "Открыть заявку"
      : freeSlots > 0
        ? "Присоединиться"
        : waitlistEnabled
          ? "В лист ожидания"
          : "Мест нет";
  const participantsLabel = `${participants.length}/${maxPlayers}`;
  const waitlistCount = game.waitlist?.length ?? 0;

  return (
    <article className="find-game-card">
      <div className="find-game-card-head">
        <CalendarDateBadge
          monthLabel={badgeLabels.monthLabel}
          dayLabel={badgeLabels.dayLabel}
          weekdayLabel={badgeLabels.weekdayLabel}
          variant="game-card"
          badgeClassName="game-created-date-badge"
          buttonClassName="game-created-date-badge-button"
          disabled={!game.booking?.date || (!game.booking?.timeFrom && !game.booking?.timeTo)}
          onClick={() => addGameToCalendar(game)}
        />
        <div className="find-game-main">
          <div className="find-game-date">{formatDateLine(game)}</div>
          <div className="find-game-time">{formatTimeLine(game)}</div>
          <div className="find-game-location">{formatLocationLine(game)}</div>
        </div>
        <div className="find-game-count">{participantsLabel}</div>
      </div>

      <div className="find-game-tags">
        <span className="game-created-tag game-created-tag-level">{getGameFormatLabel(maxPlayers)}</span>
        <span className="game-created-tag game-created-tag-range">{getRatingTag(game)}</span>
        {freeSlots > 0 ? (
          <span className="game-created-tag game-created-tag-neutral">
            {freeSlots === 1 ? "1 слот" : `${freeSlots} слота`}
          </span>
        ) : (
          <span className="game-created-tag game-created-tag-waitlist">Лист ожидания</span>
        )}
        {viewer.level && <span className="game-created-tag game-created-tag-duration">Ваш {viewer.level}</span>}
        {waitlistCount > 0 && (
          <span className="game-created-tag game-created-tag-waitlist">Ожидают: {waitlistCount}</span>
        )}
      </div>

      <div className={`find-game-players${maxPlayers <= 2 ? " find-game-players-singles" : ""}`}>
        {participants.map((player, index) => (
          <GamePlayerAvatar key={getPlayerKey(player, index)} player={player} index={index} />
        ))}
        {Array.from({ length: freeSlots }, (_, index) => (
          <EmptyPlayerSlot key={`empty-${index}`} />
        ))}
      </div>

      {game.organizer?.name && (
        <div className="find-game-organizer">
          Организатор: <span>{game.organizer.name}</span>
        </div>
      )}

      <button
        type="button"
        className="find-game-action"
        disabled={freeSlots <= 0 && !waitlistEnabled && viewerState === "none"}
        onClick={() => onOpen(game)}
      >
        {actionLabel}
      </button>
    </article>
  );
}

export default function FindGamePage({
  onBack,
  cabinetUrl = DEFAULT_CABINET_URL,
  presetStudioId = null,
  presetStudioName = null,
}: FindGamePageProps) {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [games, setGames] = useState<PadelGameRecord[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const requestInFlightRef = useRef(false);

  const viewer = useMemo(() => ({
    id: profile?.id ?? null,
    phone: normalizePhone(profile?.phone),
    level: getViewerLevel(profile),
  }), [profile]);

  const buildCreateUrl = useCallback(() => {
    const url = buildAbsolutePageUrl(DEFAULT_GAME_CREATE_PATH);
    const stationId = String(presetStudioId || "").trim();
    const stationName = String(presetStudioName || "").trim();
    if (stationId) {
      url.searchParams.set("stationId", stationId);
    }
    if (stationName) {
      url.searchParams.set("station", stationName);
    }
    return url.toString();
  }, [presetStudioId, presetStudioName]);

  const buildJoinUrl = useCallback((game: PadelGameRecord) => {
    const normalizedInvite = normalizeUrl(game.inviteUrl);
    if (normalizedInvite) return normalizedInvite;

    const url = buildAbsolutePageUrl(DEFAULT_GAME_JOIN_PATH);
    url.searchParams.set("joinGame", game.id);
    const resolvedCabinetUrl = String(cabinetUrl || DEFAULT_CABINET_URL || "").trim();
    if (resolvedCabinetUrl) {
      url.searchParams.set("cabinetUrl", resolvedCabinetUrl);
    }
    return url.toString();
  }, [cabinetUrl]);

  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    window.location.href = String(cabinetUrl || DEFAULT_CABINET_URL || "/lk_new");
  }, [cabinetUrl, onBack]);

  const loadPage = useCallback(async (nextOffset: number, mode: "replace" | "append") => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    if (mode === "replace") {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      const response = await apiFetchPadelAvailableGames({
        limit: PAGE_SIZE,
        offset: nextOffset,
        stationId: presetStudioId,
        stationName: presetStudioName,
      });
      const incoming = (response.data?.games ?? [])
        .filter((game) => matchesStationFilter(game, presetStudioId, presetStudioName))
        .filter((game) => isJoinablePublicGame(game, viewer));

      setGames((prev) => (mode === "replace" ? mergeGames([], incoming) : mergeGames(prev, incoming)));
      setTotal(response.data?.total ?? incoming.length);
      setHasMore(response.data?.hasMore ?? incoming.length >= PAGE_SIZE);
      setOffset(nextOffset + (response.data?.games.length ?? incoming.length));

      if (response.error && mode === "replace") {
        setError(response.error.message || "Не удалось загрузить игры");
      }
    } catch {
      if (mode === "replace") {
        setGames([]);
      }
      setError("Не удалось загрузить игры");
      setHasMore(false);
    } finally {
      requestInFlightRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [presetStudioId, presetStudioName, viewer]);

  useEffect(() => {
    let alive = true;
    apiFetchProfile()
      .then((response) => {
        if (!alive) return;
        setProfile(response.data ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setProfile(null);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setGames([]);
    setOffset(0);
    setHasMore(true);
    void loadPage(0, "replace");
  }, [loadPage]);

  useEffect(() => {
    if (!hasMore || loading || loadingMore) return undefined;

    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      void loadPage(offset, "append");
    }, {
      rootMargin: "260px 0px",
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, loadPage, offset]);

  const visibleCountLabel = games.length > 0
    ? `${games.length}${total > games.length ? ` из ${total}` : ""}`
    : "";

  return (
    <div className="app-container game-container find-game-container">
      <div className="page-header">
        <button className="page-back" onClick={handleBack} type="button">
          Кабинет
        </button>
        <div className="page-title">Играть</div>
      </div>

      <div className="find-game-hero">
        <button
          type="button"
          className="find-game-create"
          onClick={() => {
            window.location.href = buildCreateUrl();
          }}
        >
          <span className="find-game-create-title">Создать игру</span>
          <span className="find-game-create-sub">Выберите станцию, время и откройте набор игроков</span>
        </button>
      </div>

      <div className="find-game-section-head">
        <div>
          <div className="game-section-title">Доступные игры</div>
          {presetStudioName && <div className="find-game-section-sub">{presetStudioName}</div>}
        </div>
        {visibleCountLabel && <div className="find-game-total">{visibleCountLabel}</div>}
      </div>

      {loading && <div className="community-loading-note find-game-loading">Загружаем игры...</div>}

      {!loading && error && (
        <div className="find-game-empty">
          <div>{error}</div>
          <button type="button" className="section-cta section-cta-secondary" onClick={() => loadPage(0, "replace")}>
            Повторить
          </button>
        </div>
      )}

      {!loading && !error && games.length === 0 && (
        <div className="find-game-empty">
          <div className="find-game-empty-title">Пока нет открытых игр</div>
          <div className="find-game-empty-text">Создайте игру первым, остальные игроки увидят ее в этом списке.</div>
        </div>
      )}

      {!loading && !error && games.length > 0 && (
        <div className="find-game-list">
          {games.map((game) => (
            <FindGameCard
              key={game.id}
              game={game}
              viewer={viewer}
              onOpen={(targetGame) => {
                window.location.href = buildJoinUrl(targetGame);
              }}
            />
          ))}
        </div>
      )}

      {hasMore && !error && (
        <div ref={loadMoreRef} className="community-loading-note find-game-loading">
          {loadingMore ? "Подгружаем еще игры..." : "Прокрутите ниже, чтобы подгрузить еще игры"}
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  Booking,
  BookingsResponse,
  PadelGameRecord,
  TournamentHistoryRecord,
} from "../../utils/apiClient";
import { BookingCard } from "./BookingCard";
import { Modal } from "../UI/Modal";
import { TournamentBookingCard } from "./TournamentBookingCard";

interface BookingsContainerProps {
  activeBookings: BookingsResponse | null;
  historyBookings: BookingsResponse | null;
  historyLoading?: boolean;
  openHistory: () => void;
  preloadHistory?: () => void;
  loadBookings: () => void;
  hasMoreActiveRecords?: boolean;
  loadingMoreActiveRecords?: boolean;
  onLoadMoreActiveRecords?: () => void;
  gameRecords?: PadelGameRecord[];
  onCreateTeamGame?: (booking: Booking) => void;
  hasTeamGameForBooking?: (booking: Booking) => boolean;
  renderGameCard?: (
    game: PadelGameRecord,
    options?: {
      onBeforeOpen?: () => void;
    },
  ) => ReactNode;
  loadingGameRecords?: boolean;
  gameRecordsError?: string | null;
  resolveGameForBooking?: (booking: Booking) => PadelGameRecord | null;
  resolveTournamentForBooking?: (booking: Booking) => TournamentHistoryRecord | null;
  onOpenTournamentDetails?: (booking: Booking) => void;
}

const TABS = [
  { key: "games", label: "Игры" },
  { key: "trainings", label: "Тренировки" },
  { key: "tournaments", label: "Турниры" },
] as const;

type TabKey = (typeof TABS)[number]["key"];
type ActiveTabKey = "all" | TabKey;
const ACTIVE_RECORDS_PREVIEW_LIMIT = 3;
const RESULT_ENTRY_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;
type GamesAwareItem = {
  type: "game" | "booking";
  key: string;
  timestamp: number;
  game?: PadelGameRecord;
  booking?: Booking;
};

function getBookingCategory(name: string): "games" | "trainings" | "tournaments" | "other" {
  const n = name.toLowerCase();
  if (
    n.includes("турнир")
    || n.includes("tournament")
    || n.includes("американо")
    || n.includes("americano")
    || n.includes("мексикано")
    || n.includes("mexicano")
    || n.includes("round robin")
    || n.includes("олимп")
  ) {
    return "tournaments";
  }
  if (
    n.includes("своя игра")
    || n.includes("свою игру")
    || n.includes("игр")
    || n.includes("game")
    || n.includes("сплит")
    || n.includes("split")
  ) {
    return "games";
  }
  if (n.includes("трен") || n.includes("training")) return "trainings";
  return "other";
}

function getBookingCategoryName(booking: Booking): string {
  return [
    booking.exercise?.direction?.name,
    booking.exercise?.type?.name,
  ]
    .filter(Boolean)
    .join(" ");
}

function getBookingTimestamp(booking: Booking): number {
  const raw = booking.exercise?.timeFrom;
  if (!raw) return Number.POSITIVE_INFINITY;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function getGameTimestamp(game: PadelGameRecord, type: "start" | "end" = "start"): number {
  const date = game.booking?.date;
  const rawTime =
    type === "end"
      ? (game.booking?.timeTo ?? game.booking?.timeFrom)
      : (game.booking?.timeFrom ?? game.booking?.timeTo);
  if (rawTime) {
    const directParsed = new Date(rawTime).getTime();
    if (Number.isFinite(directParsed)) return directParsed;
  }
  if (!date || !rawTime) return Number.POSITIVE_INFINITY;
  const normalizedTime = /^\d{2}:\d{2}$/.test(rawTime) ? `${rawTime}:00` : rawTime;
  const parsed = new Date(`${date}T${normalizedTime}`).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function getBookingDateKey(booking: Booking): string | null {
  const raw = booking.exercise?.timeFrom;
  if (!raw) return null;
  const matched = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (matched) return matched;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getBookingTimeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const matched = value.match(/T?(\d{2}:\d{2})/)?.[1];
  if (matched) return matched;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getBookingDurationMinutes(booking: Booking): number | null {
  const fromTs = booking.exercise?.timeFrom ? Date.parse(booking.exercise.timeFrom) : NaN;
  const toTs = booking.exercise?.timeTo ? Date.parse(booking.exercise.timeTo) : NaN;
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return null;
  return Math.round((toTs - fromTs) / 60000);
}

function getGameWithBookingSchedule(game: PadelGameRecord, booking: Booking): PadelGameRecord {
  const bookingDate = getBookingDateKey(booking);
  const timeFrom = getBookingTimeLabel(booking.exercise?.timeFrom);
  const timeTo = getBookingTimeLabel(booking.exercise?.timeTo);
  const hasScheduleOverride = Boolean(bookingDate || timeFrom || timeTo);
  if (!hasScheduleOverride && !booking.exercise?.studio && !booking.exercise?.room) return game;

  return {
    ...game,
    booking: {
      ...(game.booking ?? {
        studioName: null,
        roomName: null,
        date: null,
        timeFrom: null,
        timeTo: null,
        durationMinutes: null,
      }),
      studioName: booking.exercise?.studio?.name ?? game.booking?.studioName ?? null,
      roomName: booking.exercise?.room?.name ?? game.booking?.roomName ?? null,
      date: bookingDate ?? game.booking?.date ?? null,
      timeFrom: timeFrom ?? game.booking?.timeFrom ?? null,
      timeTo: timeTo ?? game.booking?.timeTo ?? null,
      durationMinutes: getBookingDurationMinutes(booking) ?? game.booking?.durationMinutes ?? null,
      studioId: booking.exercise?.studio?.id != null ? String(booking.exercise.studio.id) : game.booking?.studioId ?? null,
      roomId: booking.exercise?.room?.id != null ? String(booking.exercise.room.id) : game.booking?.roomId ?? null,
      bookingId: booking.id ?? game.booking?.bookingId ?? null,
      bookingIds: Array.from(new Set([...(game.booking?.bookingIds ?? []), booking.id].filter(Boolean))),
      exerciseId: booking.exercise?.id ?? game.booking?.exerciseId ?? null,
      vivaExerciseId: game.booking?.vivaExerciseId ?? null,
      subServiceIds: game.booking?.subServiceIds ?? [],
    },
  };
}

function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getGameDateKey(game: PadelGameRecord): string | null {
  const rawDate = String(game.booking?.date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
    return rawDate.slice(0, 10);
  }

  const startTs = getGameTimestamp(game, "start");
  if (!Number.isFinite(startTs)) return null;
  const parsed = new Date(startTs);
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isCancelledGameRecord(game: PadelGameRecord): boolean {
  return String(game.status || "").toUpperCase().includes("CANCEL");
}

function hasCompletedMatchResult(game: PadelGameRecord): boolean {
  const metadata = game.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const matchResult = (metadata as Record<string, unknown>).matchResult;
  if (!matchResult || typeof matchResult !== "object" || Array.isArray(matchResult)) return false;

  const status = String((matchResult as Record<string, unknown>).status || "").trim().toUpperCase();
  if (status.includes("CONFIRM") || status.includes("COMPLET")) return true;
  return Boolean((matchResult as Record<string, unknown>).confirmedAt);
}

function hasEnteredMatchResult(game: PadelGameRecord): boolean {
  const metadata = game.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const matchResult = (metadata as Record<string, unknown>).matchResult;
  if (!matchResult || typeof matchResult !== "object" || Array.isArray(matchResult)) return false;
  const sets = (matchResult as Record<string, unknown>).sets;
  if (Array.isArray(sets) && sets.length > 0) return true;
  const status = String((matchResult as Record<string, unknown>).status || "").trim();
  return Boolean(status || (matchResult as Record<string, unknown>).submittedAt || (matchResult as Record<string, unknown>).confirmedAt);
}

function shouldKeepGameActiveForResultEntry(game: PadelGameRecord): boolean {
  if (isCancelledGameRecord(game) || hasEnteredMatchResult(game)) return false;
  const startTs = getGameTimestamp(game, "start");
  if (
    getGameDateKey(game) === getTodayDateKey()
    && Number.isFinite(startTs)
    && startTs <= Date.now()
  ) {
    return true;
  }

  const endTs = getGameTimestamp(game, "end");
  if (!Number.isFinite(endTs)) return false;
  const now = Date.now();
  return endTs < now && now - endTs <= RESULT_ENTRY_GRACE_WINDOW_MS;
}

function isUpcomingGameRecord(game: PadelGameRecord): boolean {
  if (isCancelledGameRecord(game)) return false;
  if (shouldKeepGameActiveForResultEntry(game)) return true;
  const endTs = getGameTimestamp(game, "end");
  if (!Number.isFinite(endTs)) return !hasCompletedMatchResult(game);
  return endTs >= Date.now();
}

function collectLinkedGameIds(
  bookings: Booking[],
  resolveGameForBooking?: (booking: Booking) => PadelGameRecord | null,
): Set<string> {
  const linkedIds = new Set<string>();
  bookings.forEach((booking) => {
    const linkedGame = resolveGameForBooking?.(booking) ?? null;
    if (linkedGame?.id) {
      linkedIds.add(linkedGame.id);
    }
  });
  return linkedIds;
}

function buildGamesAwareItems(
  bookings: Booking[],
  standaloneGames: PadelGameRecord[] = [],
  resolveGameForBooking?: (booking: Booking) => PadelGameRecord | null,
  sortOrder: "asc" | "desc" = "asc",
): GamesAwareItem[] {
  const seenGameIds = new Set<string>();
  const items: GamesAwareItem[] = [];

  bookings.forEach((booking) => {
    const linkedGame = resolveGameForBooking?.(booking) ?? null;
    if (linkedGame && linkedGame.id) {
      if (seenGameIds.has(linkedGame.id)) return;
      seenGameIds.add(linkedGame.id);
      const gameWithCurrentBooking = getGameWithBookingSchedule(linkedGame, booking);
      items.push({
        type: "game",
        key: `game-${linkedGame.id}`,
        timestamp: getGameTimestamp(gameWithCurrentBooking, "start"),
        game: gameWithCurrentBooking,
      });
      return;
    }

    items.push({
      type: "booking",
      key: `booking-${booking.id}`,
      timestamp: getBookingTimestamp(booking),
      booking,
    });
  });

  standaloneGames.forEach((game) => {
    if (!game?.id || seenGameIds.has(game.id)) return;
    seenGameIds.add(game.id);
    items.push({
      type: "game",
      key: `game-${game.id}`,
      timestamp: getGameTimestamp(game, "start"),
      game,
    });
  });

  return items.sort((left, right) => {
    const leftFinite = Number.isFinite(left.timestamp);
    const rightFinite = Number.isFinite(right.timestamp);
    if (!leftFinite && !rightFinite) return 0;
    if (!leftFinite) return 1;
    if (!rightFinite) return -1;
    return sortOrder === "desc"
      ? right.timestamp - left.timestamp
      : left.timestamp - right.timestamp;
  });
}

export function BookingsContainer({
  activeBookings,
  historyBookings,
  historyLoading = false,
  openHistory,
  preloadHistory,
  loadBookings,
  hasMoreActiveRecords = false,
  loadingMoreActiveRecords = false,
  onLoadMoreActiveRecords,
  gameRecords = [],
  onCreateTeamGame,
  hasTeamGameForBooking,
  renderGameCard,
  loadingGameRecords = false,
  gameRecordsError = null,
  resolveGameForBooking,
  resolveTournamentForBooking,
  onOpenTournamentDetails,
}: BookingsContainerProps) {
  const [activeTab, setActiveTab] = useState<ActiveTabKey>("all");
  const [activeRecordsExpanded, setActiveRecordsExpanded] = useState(false);
  const [isGamesHistoryOpen, setIsGamesHistoryOpen] = useState(false);
  const [gamesHistoryType, setGamesHistoryType] = useState<"visited" | "cancelled">("visited");

  const historyLoaded = historyBookings !== null;
  const hasHistory = historyLoaded
    ? Boolean(historyBookings?.content.length)
    : true;

  const activeList = activeBookings?.content || [];
  const sortedActive = [...activeList].sort((a, b) => {
    const aTime = a.exercise?.timeFrom ? new Date(a.exercise.timeFrom).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.exercise?.timeFrom ? new Date(b.exercise.timeFrom).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });

  const filteredActive = activeTab === "all"
    ? sortedActive
    : sortedActive.filter((book) => {
        return getBookingCategory(getBookingCategoryName(book)) === activeTab;
      });
  const gamesTabEnabled = activeTab === "games" && typeof renderGameCard === "function";

  useEffect(() => {
    if (!gamesTabEnabled && isGamesHistoryOpen) {
      setIsGamesHistoryOpen(false);
    }
  }, [gamesTabEnabled, isGamesHistoryOpen]);

  const gamesActiveBookings = useMemo(() => {
    return sortedActive.filter((book) => {
      return getBookingCategory(getBookingCategoryName(book)) === "games";
    });
  }, [sortedActive]);

  const gamesHistoryBookings = useMemo(() => {
    const source = historyBookings?.content || [];
    return source.filter((book) => {
      return getBookingCategory(getBookingCategoryName(book)) === "games";
    });
  }, [historyBookings?.content]);
  const activeGameRecords = useMemo(
    () => gameRecords.filter((game) => isUpcomingGameRecord(game)),
    [gameRecords],
  );
  const historyGameRecords = useMemo(
    () => gameRecords.filter((game) => !isUpcomingGameRecord(game)),
    [gameRecords],
  );

  const linkedGamesInGamesBookings = useMemo(
    () => collectLinkedGameIds(gamesActiveBookings, resolveGameForBooking),
    [gamesActiveBookings, resolveGameForBooking],
  );
  const filteredGamesHistoryBookings = useMemo(() => {
    return gamesHistoryBookings.filter((booking) => {
      const matchesTab = gamesHistoryType === "cancelled" ? booking.isCancelled === true : booking.isCancelled === false;
      if (!matchesTab) return false;
      const linkedGame = resolveGameForBooking?.(booking) ?? null;
      if (!linkedGame) return true;
      if (linkedGamesInGamesBookings.has(linkedGame.id)) return false;
      return !isUpcomingGameRecord(getGameWithBookingSchedule(linkedGame, booking));
    });
  }, [gamesHistoryBookings, gamesHistoryType, linkedGamesInGamesBookings, resolveGameForBooking]);
  const linkedGamesInAllActiveBookings = useMemo(
    () => collectLinkedGameIds(sortedActive, resolveGameForBooking),
    [sortedActive, resolveGameForBooking],
  );

  const standaloneGamesForGamesTab = useMemo(
    () => activeGameRecords.filter((game) => !linkedGamesInGamesBookings.has(game.id)),
    [activeGameRecords, linkedGamesInGamesBookings],
  );
  const standaloneGamesForAllTab = useMemo(
    () => activeGameRecords.filter((game) => !linkedGamesInAllActiveBookings.has(game.id)),
    [activeGameRecords, linkedGamesInAllActiveBookings],
  );
  const linkedGamesInFilteredGamesHistoryBookings = useMemo(
    () => collectLinkedGameIds(filteredGamesHistoryBookings, resolveGameForBooking),
    [filteredGamesHistoryBookings, resolveGameForBooking],
  );
  const standaloneGamesForGamesHistory = useMemo(
    () =>
      historyGameRecords.filter((game) => {
        const matchesTab = gamesHistoryType === "cancelled"
          ? isCancelledGameRecord(game)
          : !isCancelledGameRecord(game);
        return matchesTab && !linkedGamesInFilteredGamesHistoryBookings.has(game.id);
      }),
    [gamesHistoryType, historyGameRecords, linkedGamesInFilteredGamesHistoryBookings],
  );
  const hasGamesHistory = !historyLoaded || gamesHistoryBookings.length > 0 || historyGameRecords.length > 0;
  const hasAnyHistory = hasHistory || historyGameRecords.length > 0;
  const historyDisabled = historyLoading || (gamesTabEnabled ? !hasGamesHistory : !hasAnyHistory);

  const gamesActiveItems = useMemo(
    () => buildGamesAwareItems(gamesActiveBookings, standaloneGamesForGamesTab, resolveGameForBooking),
    [gamesActiveBookings, resolveGameForBooking, standaloneGamesForGamesTab],
  );

  const gamesHistoryItems = useMemo(
    () =>
      buildGamesAwareItems(
        filteredGamesHistoryBookings,
        standaloneGamesForGamesHistory,
        resolveGameForBooking,
        "desc",
      ),
    [filteredGamesHistoryBookings, resolveGameForBooking, standaloneGamesForGamesHistory],
  );
  const mixedAllActiveItems = useMemo(
    () => buildGamesAwareItems(filteredActive, standaloneGamesForAllTab, resolveGameForBooking),
    [filteredActive, resolveGameForBooking, standaloneGamesForAllTab],
  );
  const visibleGamesActiveItems = useMemo(
    () => (
      activeRecordsExpanded
        ? gamesActiveItems
        : gamesActiveItems.slice(0, ACTIVE_RECORDS_PREVIEW_LIMIT)
    ),
    [activeRecordsExpanded, gamesActiveItems],
  );
  const visibleMixedAllActiveItems = useMemo(
    () => (
      activeRecordsExpanded
        ? mixedAllActiveItems
        : mixedAllActiveItems.slice(0, ACTIVE_RECORDS_PREVIEW_LIMIT)
    ),
    [activeRecordsExpanded, mixedAllActiveItems],
  );
  const visibleFilteredActive = useMemo(
    () => (
      activeRecordsExpanded
        ? filteredActive
        : filteredActive.slice(0, ACTIVE_RECORDS_PREVIEW_LIMIT)
    ),
    [activeRecordsExpanded, filteredActive],
  );
  const hasHiddenActiveItems = useMemo(() => {
    const totalVisibleSource = gamesTabEnabled
      ? gamesActiveItems.length
      : activeTab === "all" && typeof renderGameCard === "function"
        ? mixedAllActiveItems.length
        : filteredActive.length;

    return !activeRecordsExpanded && totalVisibleSource > ACTIVE_RECORDS_PREVIEW_LIMIT;
  }, [
    activeRecordsExpanded,
    activeTab,
    filteredActive.length,
    gamesActiveItems.length,
    gamesTabEnabled,
    mixedAllActiveItems.length,
    renderGameCard,
  ]);
  const canLoadMoreActiveRecords = hasHiddenActiveItems || hasMoreActiveRecords;

  const handleLoadMoreActiveRecords = () => {
    if (!activeRecordsExpanded) {
      setActiveRecordsExpanded(true);
    }
    if (hasMoreActiveRecords) {
      onLoadMoreActiveRecords?.();
    }
  };

  const getEmptyActiveText = (): string => {
    if (activeTab === "trainings") {
      return "У вас нет запланированных тренировок";
    }
    if (activeTab === "tournaments") {
      return "Вы пока не записаны в турнир";
    }
    if (sortedActive.length === 0) {
      return "У вас нет предстоящих событий";
    }
    return "Нет предстоящих записей в этой категории";
  };

  const renderBookingByCategory = (booking: Booking, key: string, active: boolean) => {
    const category = getBookingCategory(getBookingCategoryName(booking));

    if (category === "tournaments") {
      return (
        <TournamentBookingCard
          key={key}
          booking={booking}
          active={active}
          customTournament={resolveTournamentForBooking?.(booking) ?? null}
          loadBookings={active ? loadBookings : undefined}
          onOpenDetails={onOpenTournamentDetails}
        />
      );
    }

    return (
      <BookingCard
        key={key}
        booking={booking}
        active={active}
        loadBookings={active ? loadBookings : undefined}
        showCreateTeamGame={
          active && category === "games" && !(hasTeamGameForBooking?.(booking) ?? false)
        }
        onCreateTeamGame={onCreateTeamGame}
      />
    );
  };

  const renderLoadMoreActiveRecordsButton = () => {
    if (!canLoadMoreActiveRecords) {
      return null;
    }

    return (
      <button
        type="button"
        className="section-cta section-cta-secondary"
        onClick={handleLoadMoreActiveRecords}
        disabled={loadingMoreActiveRecords && !hasHiddenActiveItems}
      >
        {loadingMoreActiveRecords ? "Загружаем записи..." : "Еще записи"}
      </button>
    );
  };

  return (
    <div className="section">
      <div className="section-header section-header--bookings">
        <button
          className={`all-bookings-btn all-bookings-btn--inline ${activeTab === "all" ? "active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          Все записи →
        </button>
        <button
          className="section-link section-link--bold"
          onClick={() => {
            if (gamesTabEnabled) {
              setGamesHistoryType("visited");
              setIsGamesHistoryOpen(true);
              preloadHistory?.();
              onLoadMoreActiveRecords?.();
              return;
            }
            openHistory();
          }}
          disabled={historyDisabled}
        >
          История
        </button>
      </div>

      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`tab ${activeTab === tab.key ? "active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {gamesTabEnabled ? (
        loadingGameRecords ? (
          <div style={{ padding: "16px", fontSize: 14, color: "var(--text-secondary)" }}>
            Загружаем игры...
          </div>
        ) : gamesActiveItems.length > 0 ? (
          <>
            <div className="game-created-list">
              {visibleGamesActiveItems.map((item) => {
                if (item.type === "game" && item.game) {
                  return renderGameCard?.(item.game);
                }
                if (!item.booking) return null;
                return (
                  <BookingCard
                    key={item.key}
                    booking={item.booking}
                    active={true}
                    loadBookings={loadBookings}
                    showCreateTeamGame={!(resolveGameForBooking?.(item.booking) ?? null)}
                    onCreateTeamGame={onCreateTeamGame}
                  />
                );
              })}
            </div>
            {renderLoadMoreActiveRecordsButton()}
          </>
        ) : (
          <>
            <div style={{ padding: "16px", fontSize: 14, color: "var(--text-secondary)" }}>
              {gameRecordsError || "У вас нет предстоящих игр"}
            </div>
            {renderLoadMoreActiveRecordsButton()}
          </>
        )
      ) : activeTab === "all" && typeof renderGameCard === "function" && mixedAllActiveItems.length > 0 ? (
        <>
          {visibleMixedAllActiveItems.map((item) => {
            if (item.type === "game" && item.game) {
              return renderGameCard(item.game);
            }
            if (!item.booking) return null;
            return renderBookingByCategory(item.booking, item.key, true);
          })}
          {renderLoadMoreActiveRecordsButton()}
        </>
      ) : filteredActive.length > 0 ? (
        activeTab === "all" && typeof renderGameCard === "function" ? (
          <>
            {visibleMixedAllActiveItems.map((item) => {
              if (item.type === "game" && item.game) {
                return renderGameCard(item.game);
              }
              if (!item.booking) return null;
              return renderBookingByCategory(item.booking, item.key, true);
            })}
            {renderLoadMoreActiveRecordsButton()}
          </>
        ) : (
          <>
            {visibleFilteredActive.map((book) => renderBookingByCategory(book, book.id, true))}
            {renderLoadMoreActiveRecordsButton()}
          </>
        )
      ) : (
        <>
          <div style={{ padding: "16px", fontSize: 14, color: "var(--text-secondary)" }}>
            {getEmptyActiveText()}
          </div>
          {renderLoadMoreActiveRecordsButton()}
        </>
      )}

      <Modal
        isOpen={isGamesHistoryOpen}
        onClose={() => setIsGamesHistoryOpen(false)}
        title="Прошедшие записи"
      >
        <div className="booking-history-container">
          <div className="history-tabs">
            <button
              className={`history-tab ${gamesHistoryType === "visited" ? "active" : ""}`}
              onClick={() => setGamesHistoryType("visited")}
            >
              Посещённые
            </button>
            <button
              className={`history-tab ${gamesHistoryType === "cancelled" ? "active" : ""}`}
              onClick={() => setGamesHistoryType("cancelled")}
            >
              Отменённые
            </button>
          </div>

          {gamesHistoryItems.length > 0 ? (
            <div className="game-created-list">
              {gamesHistoryItems.map((item) => {
                if (item.type === "game" && item.game) {
                  return renderGameCard?.(item.game, {
                    onBeforeOpen: () => setIsGamesHistoryOpen(false),
                  });
                }
                if (!item.booking) return null;
                return (
                  <BookingCard
                    key={item.key}
                    booking={item.booking}
                    active={false}
                  />
                );
              })}
            </div>
          ) : (
            <div className="booking-empty">
              {gamesHistoryType === "visited" ? "Нет посещённых записей" : "Нет отменённых записей"}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

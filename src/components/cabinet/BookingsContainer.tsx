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
}

const TABS = [
  { key: "games", label: "Игры" },
  { key: "trainings", label: "Тренировки" },
  { key: "tournaments", label: "Турниры" },
] as const;

type TabKey = (typeof TABS)[number]["key"];
type ActiveTabKey = "all" | TabKey;
const ACTIVE_RECORDS_PREVIEW_LIMIT = 3;
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
  if (n.includes("трен") || n.includes("training")) return "trainings";
  if (n.includes("игр") || n.includes("game")) return "games";
  return "other";
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

function isUpcomingGameRecord(game: PadelGameRecord): boolean {
  if (isCancelledGameRecord(game)) return false;
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
      items.push({
        type: "game",
        key: `game-${linkedGame.id}`,
        timestamp: getGameTimestamp(linkedGame, "start"),
        game: linkedGame,
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
        const name = book.exercise?.direction?.name || book.exercise?.type?.name || "";
        return getBookingCategory(name) === activeTab;
      });
  const gamesTabEnabled = activeTab === "games" && typeof renderGameCard === "function";

  useEffect(() => {
    if (!gamesTabEnabled && isGamesHistoryOpen) {
      setIsGamesHistoryOpen(false);
    }
  }, [gamesTabEnabled, isGamesHistoryOpen]);

  const gamesActiveBookings = useMemo(() => {
    return sortedActive.filter((book) => {
      const name = book.exercise?.direction?.name || book.exercise?.type?.name || "";
      return getBookingCategory(name) === "games";
    });
  }, [sortedActive]);

  const gamesHistoryBookings = useMemo(() => {
    const source = historyBookings?.content || [];
    return source.filter((book) => {
      const name = book.exercise?.direction?.name || book.exercise?.type?.name || "";
      return getBookingCategory(name) === "games";
    });
  }, [historyBookings?.content]);
  const filteredGamesHistoryBookings = useMemo(() => {
    return gamesHistoryBookings.filter((booking) =>
      gamesHistoryType === "cancelled" ? booking.isCancelled === true : booking.isCancelled === false
    );
  }, [gamesHistoryBookings, gamesHistoryType]);
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
    const directionName = booking.exercise?.direction?.name || booking.exercise?.type?.name || "";
    const category = getBookingCategory(directionName);

    if (category === "tournaments") {
      return (
        <TournamentBookingCard
          key={key}
          booking={booking}
          active={active}
          customTournament={resolveTournamentForBooking?.(booking) ?? null}
          loadBookings={active ? loadBookings : undefined}
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

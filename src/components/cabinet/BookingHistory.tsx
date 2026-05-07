import React, { useMemo, useState } from "react";
import { Modal } from "../UI/Modal";
import type {
  BookingsResponse,
  Booking,
  PadelGameRecord,
  TournamentHistoryRecord,
} from "../../utils/apiClient";
import { BookingCard } from "./BookingCard";
import type { ReactNode } from "react";
import { TournamentBookingCard } from "./TournamentBookingCard";

const RESULT_ENTRY_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface BookingHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  loading?: boolean;
  historyBookings: BookingsResponse | null;
  gameRecords?: PadelGameRecord[];
  renderGameCard?: (
    game: PadelGameRecord,
    options?: {
      onBeforeOpen?: () => void;
    },
  ) => ReactNode;
  resolveGameForBooking?: (booking: Booking) => PadelGameRecord | null;
  resolveTournamentForBooking?: (booking: Booking) => TournamentHistoryRecord | null;
  onOpenTournamentDetails?: (booking: Booking) => void;
}

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

export const BookingHistory: React.FC<BookingHistoryProps> = ({
  isOpen,
  onClose,
  loading = false,
  historyBookings,
  gameRecords = [],
  renderGameCard,
  resolveGameForBooking,
  resolveTournamentForBooking,
  onOpenTournamentDetails,
}) => {
  const [bookingsType, setBookingsType] = useState("visited");

  const historyList = historyBookings?.content || [];
  const filteredBookings = historyList.filter((booking: Booking) =>
    bookingsType === "cancelled" ? booking.isCancelled === true : booking.isCancelled === false
  );
  const standaloneHistoryGames = useMemo(() => {
    const linkedGameIds = new Set<string>();
    filteredBookings.forEach((booking) => {
      const linkedGame = resolveGameForBooking?.(booking) ?? null;
      if (linkedGame?.id) {
        linkedGameIds.add(linkedGame.id);
      }
    });

    return gameRecords.filter((game) => {
      if (isUpcomingGameRecord(game)) return false;
      const matchesTab = bookingsType === "cancelled"
        ? isCancelledGameRecord(game)
        : !isCancelledGameRecord(game);
      return matchesTab && !linkedGameIds.has(game.id);
    });
  }, [bookingsType, filteredBookings, gameRecords, resolveGameForBooking]);
  const historyItems = useMemo(() => {
    const bookingItems = filteredBookings.map((booking) => ({
      type: "booking" as const,
      booking,
      timestamp: getBookingTimestamp(booking),
    }));
    const gameItems = standaloneHistoryGames.map((game) => ({
      type: "game" as const,
      game,
      timestamp: getGameTimestamp(game, "start"),
    }));

    return [...bookingItems, ...gameItems].sort((left, right) => {
      const leftFinite = Number.isFinite(left.timestamp);
      const rightFinite = Number.isFinite(right.timestamp);
      if (!leftFinite && !rightFinite) return 0;
      if (!leftFinite) return 1;
      if (!rightFinite) return -1;
      return right.timestamp - left.timestamp;
    });
  }, [filteredBookings, standaloneHistoryGames]);

  if (!isOpen) return null;

  const seenGames = new Set<string>();
  const hasHistoryItems = historyItems.length > 0;
  const showLoadingState = loading && historyBookings === null && !hasHistoryItems;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Прошедшие записи">
      <div className="booking-history-container">
        <div className="history-tabs">
          <button
            className={`history-tab ${bookingsType === "visited" ? "active" : ""}`}
            onClick={() => setBookingsType("visited")}
          >
            Посещённые
          </button>
          <button
            className={`history-tab ${bookingsType === "cancelled" ? "active" : ""}`}
            onClick={() => setBookingsType("cancelled")}
          >
            Отменённые
          </button>
        </div>
        {showLoadingState ? (
          <div className="booking-empty">Загружаем историю...</div>
        ) : hasHistoryItems ? (
          <div className="booking-container">
            {historyItems.map((item) => {
              if (item.type === "booking") {
                const linkedGame = resolveGameForBooking?.(item.booking) ?? null;
                if (linkedGame?.id && renderGameCard) {
                  if (isUpcomingGameRecord(linkedGame)) return null;
                  if (seenGames.has(linkedGame.id)) return null;
                  seenGames.add(linkedGame.id);
                  return (
                    <React.Fragment key={`game-${linkedGame.id}`}>
                      {renderGameCard(linkedGame, { onBeforeOpen: onClose })}
                    </React.Fragment>
                  );
                }
                const category = getBookingCategory(
                  item.booking.exercise?.direction?.name || item.booking.exercise?.type?.name || "",
                );
                if (category === "tournaments") {
                  return (
                    <TournamentBookingCard
                      key={`booking-${item.booking.id}`}
                      booking={item.booking}
                      active={false}
                      customTournament={resolveTournamentForBooking?.(item.booking) ?? null}
                      onOpenDetails={onOpenTournamentDetails}
                    />
                  );
                }
                return <BookingCard key={`booking-${item.booking.id}`} booking={item.booking} active={false} />;
              }

              if (!renderGameCard || seenGames.has(item.game.id)) return null;
              seenGames.add(item.game.id);
              return (
                <React.Fragment key={`game-${item.game.id}`}>
                  {renderGameCard(item.game, { onBeforeOpen: onClose })}
                </React.Fragment>
              );
            })}
          </div>
        ) : (
          <div className="booking-empty">
            {bookingsType === "visited" ? "Нет посещённых записей" : "Нет отменённых записей"}
          </div>
        )}
      </div>
    </Modal>
  );
};

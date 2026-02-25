import { useState } from "react";
import type { BookingsResponse } from "../../utils/apiClient";
import { BookingCard } from "./BookingCard";

interface BookingsContainerProps {
  activeBookings: BookingsResponse | null;
  historyBookings: BookingsResponse | null;
  openHistory: () => void;
  loadBookings: () => void;
}

const TABS = [
  { key: "games", label: "Игры" },
  { key: "trainings", label: "Тренировки" },
  { key: "tournaments", label: "Турниры" },
] as const;

type TabKey = (typeof TABS)[number]["key"];
type ActiveTabKey = "all" | TabKey;

function getBookingCategory(name: string): "games" | "trainings" | "tournaments" | "other" {
  const n = name.toLowerCase();
  if (n.includes("турнир") || n.includes("tournament")) return "tournaments";
  if (n.includes("трен") || n.includes("training")) return "trainings";
  if (n.includes("игр") || n.includes("game")) return "games";
  return "other";
}

export function BookingsContainer({
  activeBookings,
  historyBookings,
  openHistory,
  loadBookings,
}: BookingsContainerProps) {
  const [activeTab, setActiveTab] = useState<ActiveTabKey>("all");

  const hasHistory = Boolean(historyBookings && historyBookings.content.length > 0);

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
          onClick={openHistory}
          disabled={!hasHistory}
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

      {filteredActive.length > 0 ? (
        filteredActive.map((book) => (
          <BookingCard key={book.id} booking={book} active={true} loadBookings={loadBookings} />
        ))
      ) : (
        <div style={{ padding: "16px", fontSize: 14, color: "var(--text-secondary)" }}>
          {sortedActive.length === 0
            ? "У вас нет предстоящих событий"
            : "Нет предстоящих записей в этой категории"}
        </div>
      )}
    </div>
  );
}

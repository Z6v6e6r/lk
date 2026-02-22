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
  { key: "all", label: "Все записи" },
  { key: "games", label: "Игры" },
  { key: "trainings", label: "Тренировки" },
  { key: "tournaments", label: "Турниры" },
];

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
  const [activeTab, setActiveTab] = useState(0);

  const hasActive = activeBookings && activeBookings.content.length > 0;
  const hasHistory = historyBookings && historyBookings.content.length > 0;

  if (!hasActive && !hasHistory) return null;

  const activeList = activeBookings?.content || [];
  const sortedActive = [...activeList].sort((a, b) => {
    const aTime = a.exercise?.timeFrom ? new Date(a.exercise.timeFrom).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.exercise?.timeFrom ? new Date(b.exercise.timeFrom).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });
  const currentTab = TABS[activeTab]?.key || "all";
  const filteredActive = currentTab === "all"
    ? sortedActive
    : sortedActive.filter((book) => {
        const name = book.exercise?.direction?.name || book.exercise?.type?.name || "";
        return getBookingCategory(name) === currentTab;
      });

  return (
    <div className="section">
      <div className="section-header">
        <span className="section-title">Предстоящие записи</span>
        {hasHistory && (
          <button className="section-link section-link--bold" onClick={openHistory}>
            История
          </button>
        )}
      </div>

      <div className="tabs">
        {TABS.map((tab, i) => (
          <button
            key={tab.key}
            className={`tab ${activeTab === i ? "active" : ""}`}
            onClick={() => setActiveTab(i)}
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
          Нет предстоящих записей в этой категории
        </div>
      )}

      {hasHistory && (
        <button className="all-bookings-btn" onClick={openHistory}>
          Все записи →
        </button>
      )}
    </div>
  );
}

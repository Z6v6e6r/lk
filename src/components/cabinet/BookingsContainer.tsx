import { useState } from "react";
import type { BookingsResponse } from "../../utils/apiClient";
import { BookingCard } from "./BookingCard";

interface BookingsContainerProps {
  activeBookings: BookingsResponse | null;
  historyBookings: BookingsResponse | null;
  openHistory: () => void;
  loadBookings: () => void;
}

const TABS = ["Все", "Активные", "История"];

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

  const showActive = activeTab === 0 || activeTab === 1;
  const showHistory = activeTab === 0 || activeTab === 2;

  return (
    <div className="section">
      <div className="section-header">
        <span className="section-title">Предстоящие записи</span>
        {hasHistory && (
          <button className="section-link" onClick={openHistory}>
            История
          </button>
        )}
      </div>

      <div className="tabs">
        {TABS.map((tab, i) => (
          <button
            key={tab}
            className={`tab ${activeTab === i ? "active" : ""}`}
            onClick={() => setActiveTab(i)}
          >
            {tab}
          </button>
        ))}
      </div>

      {showActive && hasActive &&
        activeBookings!.content.map((book) => (
          <BookingCard key={book.id} booking={book} active={true} loadBookings={loadBookings} />
        ))
      }

      {showHistory && hasHistory && (
        <button className="all-bookings-btn" onClick={openHistory}>
          Все записи →
        </button>
      )}
    </div>
  );
}

import React, { useState } from "react";
import { Modal } from "../UI/Modal";
import type { BookingsResponse, Booking } from "../../utils/apiClient";
import { BookingCard } from "./BookingCard";

interface BookingHistoryProps {
  isOpen: boolean;
  onClose: () => void;
  historyBookings: BookingsResponse | null;
}

export const BookingHistory: React.FC<BookingHistoryProps> = ({
  isOpen,
  onClose,
  historyBookings,
}) => {
  const [bookingsType, setBookingsType] = useState("visited");

  if (!isOpen || !historyBookings || historyBookings.content.length == 0)
    return null;

  const filteredBookings = historyBookings.content.filter((booking: Booking) =>
    bookingsType === "cancelled" ? booking.isCancelled === true : booking.isCancelled === false
  );

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
        {filteredBookings.length > 0 ? (
          <div className="booking-container">
            {filteredBookings.map((book) => (
              <BookingCard key={book.id} booking={book} active={false} />
            ))}
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
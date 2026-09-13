import { useRef, useState } from "react";
import {
  apiCleanupPadelGameByOrganizer,
  apiFetchBookings,
  apiFetchPadelGameRecord,
  apiLeavePadelGameAsCurrentUser,
  apiTransferPadelGameOrganizer,
  apiReleaseSubscriptionBookingClaim,
  type Booking,
  type PadelGameRecord,
} from "../../utils/apiClient";
import { BookingCancellationDialog } from "../cabinet/BookingCancellationDialog";
import { Modal } from "../UI/Modal";
import { collectGameCancellationBookingIds, hasActiveGameLeaveMembership,
  hasOtherActiveGameMembers, organizerTransferCandidates, type GameLeaveIdentity } from "./gameLeaveMembership";

const TRANSFER_REQUIRED = "В игре есть другие игроки. Сначала передайте роль организатора одному из участников.";
const sameId = (a: unknown, b: unknown) => Boolean(a && b)
  && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

export function GameBookingCancellation({ gameId, organizer, onGameChanged }: {
  gameId: string;
  organizer: GameLeaveIdentity;
  onGameChanged?: (game: PadelGameRecord) => void;
}) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [handoff, setHandoff] = useState<{ game: PadelGameRecord; booking: Booking } | null>(null);
  const [successorId, setSuccessorId] = useState("");
  const [transferredGame, setTransferredGame] = useState<PadelGameRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const openCancellation = async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const fresh = await apiFetchPadelGameRecord(gameId);
      if (fresh.error || fresh.data?.id !== gameId) {
        setError(fresh.error?.message || "Не удалось проверить состав игры. Попробуйте снова.");
        return;
      }
      const result = await apiFetchBookings(false);
      if (result.error || !result.data) {
        setError(result.error?.message || "Не удалось загрузить запись. Попробуйте снова.");
        return;
      }
      const ids = collectGameCancellationBookingIds(fresh.data);
      const matches = result.data.content.filter((item) => !item.isCancelled
        && ids.has(item.id.trim().toLowerCase()));
      if (matches.length !== 1 || result.data.totalPages > 1) {
        setError("Не удалось однозначно определить вашу запись в игре. Отмена остановлена.");
        return;
      }
      if (!(new Date(matches[0].cancellationDeadline).getTime() > Date.now())) {
        setError("Отмена возможна только за 24 часа");
        return;
      }
      if (sameId(fresh.data.organizer?.id, organizer.id) && hasOtherActiveGameMembers(fresh.data, organizer)) {
        setSuccessorId("");
        setHandoff({ game: fresh.data, booking: matches[0] });
      } else {
        setBooking(matches[0]);
      }
    } catch {
      setError("Не удалось проверить запись. Попробуйте снова.");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  const transfer = async () => {
    if (!handoff || !successorId || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await apiTransferPadelGameOrganizer(gameId, successorId, handoff.game.updatedAt || "");
      // A lost response is never permission to cancel the game. Read the actual organizer.
      const fresh = await apiFetchPadelGameRecord(gameId);
      if (fresh.error || fresh.data?.id !== gameId || !sameId(fresh.data.organizer?.id, successorId)) {
        setError(result.error?.message || "Передача роли не подтверждена. Обновите игру и повторите выбор.");
        if (fresh.data?.id === gameId) {
          setHandoff({ ...handoff, game: fresh.data });
          setSuccessorId("");
        }
        return;
      }
      setTransferredGame(fresh.data);
      setBooking(handoff.booking);
      setHandoff(null);
    } catch {
      setError("Не удалось подтвердить передачу. Обновите игру перед повтором.");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  };

  const candidates = handoff ? organizerTransferCandidates(handoff.game, organizer) : [];
  return (
    <div>
      <div className="booking-cancel-row">
        <button className="btn-cancel danger" type="button" disabled={loading}
          onClick={() => { void openCancellation(); }}>
          {loading ? "Проверяем запись..." : "Отменить запись"}
        </button>
      </div>
      {error && !handoff && <div className="booking-status-text" role="alert">{error}</div>}
      <Modal isOpen={Boolean(handoff)} title="Кому передать роль организатора?" variant="dialog"
        onClose={() => { if (!busy.current) setHandoff(null); }}>
        <p>Чтобы покинуть игру, выберите нового организатора. Игра и записи остальных участников сохранятся.</p>
        <fieldset disabled={loading}>
          <legend>Новый организатор</legend>
          {candidates.map(player => <label key={player.id} className="details-roster-row">
            <input type="radio" name="game-organizer-successor" value={player.id}
              checked={successorId === player.id} onChange={() => setSuccessorId(player.id)} />
            <span>{player.name}</span>
          </label>)}
        </fieldset>
        {candidates.length === 0 && <p role="status">Нет участников, которым можно передать роль. Покинуть игру сейчас нельзя.</p>}
        {error && <p role="alert">{error}</p>}
        <button type="button" className="section-cta" disabled={loading || !successorId}
          onClick={() => { void transfer(); }}>
          {loading ? "Передаём роль..." : "Передать роль и продолжить"}
        </button>
      </Modal>
      {booking && <BookingCancellationDialog
        bookingId={booking.id}
        isOpen
        title={transferredGame ? "Отмена своего участия" : "Отмена записи"}
        onClose={() => {
          setBooking(null);
          if (transferredGame) onGameChanged?.(transferredGame);
        }}
        onSuccessClose={() => window.location.reload()}
        executeAction={async (action) => {
          const fresh = await apiFetchPadelGameRecord(gameId);
          if (fresh.error || fresh.data?.id !== gameId) {
            return { ok: false, message: "Не удалось проверить актуальный состав игры" };
          }
          if (!sameId(fresh.data.organizer?.id, organizer.id)) {
            const leave = await apiLeavePadelGameAsCurrentUser(gameId, { refundMethod: action.refundMethod });
            if (leave.error || !leave.data || !["DONE", "RETURN_PENDING"].includes(leave.data.state)) {
              return { ok: false, message: leave.error?.message || leave.data?.message
                || "Роль передана. Выход ещё не подтверждён — повторите отмену своего участия." };
            }
            const verification = await apiFetchPadelGameRecord(gameId);
            if (verification.error || verification.data?.id !== gameId
              || hasActiveGameLeaveMembership(verification.data, organizer)) {
              return { ok: false, message: "Роль передана. Ожидаем подтверждения выхода — повторите проверку." };
            }
            return { ok: true, message: leave.data.message || "Вы вышли из игры" };
          }
          if (hasOtherActiveGameMembers(fresh.data, organizer)) return { ok: false, message: TRANSFER_REQUIRED };
          const cleanupResult = await apiCleanupPadelGameByOrganizer(gameId, {
            force: true, dryRun: false, limit: 1, intent: "cancel_game",
            refundMethod: action.refundMethod ?? undefined,
            cancellationActionId: action.id, actorBookingId: booking.id,
          });
          const cleanupItem = cleanupResult.data?.items?.find((item) => item.gameId === gameId);
          const ok = !cleanupResult.error && cleanupItem?.cancelledInLk === true && cleanupItem.withVivaErrors !== true;
          if (!ok) return { ok: false, message: cleanupResult.error?.message || "Не удалось подтвердить серверную отмену игры" };
          if (action.id === "subscription") {
            const release = await apiReleaseSubscriptionBookingClaim(booking.id);
            if (release.error || release.data?.state !== "RELEASED") {
              return { ok: false, message: "Запись отменена в Viva, но дневной лимит ещё не синхронизирован. Повторите позже." };
            }
          }
          return { ok: true, message: cleanupItem?.refundMessage || action.successMessage };
        }}
      />}
    </div>
  );
}

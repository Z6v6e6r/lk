import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthForm } from "../auth/AuthForm";
import { useAuth } from "../../context/AuthContext";
import {
  apiCancelTournamentRegistration,
  apiFetchTournamentMyRegistration,
  apiFetchTournamentSignupDetail,
  apiFetchTournamentSignupList,
  apiRegisterForTournament,
  type TournamentRegistrationState,
  type TournamentSignupDetail,
  type TournamentSignupSummary,
} from "../../utils/tournamentSignupApi";

interface TournamentSignupPageProps {
  onBack: () => void;
  initialTournamentId?: string | null;
  initialDate?: string | null;
}

const DAYS_BEFORE_TODAY = 1;
const DAYS_AFTER_TODAY = 21;

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateFromInput(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDate(parsed);
}

function getDateLabel(date: string | null) {
  if (!date) return "Дата уточняется";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Дата уточняется";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function getStatusLabel(tournament: TournamentSignupSummary) {
  if (tournament.status === "REGISTERED") return "Вы записаны";
  if (tournament.status === "WAITLIST") return "Лист ожидания";
  if (tournament.status === "FULL") return "Мест нет";
  if (tournament.status === "CLOSED") return "Запись закрыта";
  if (tournament.status === "CANCELLED") return "Отменён";
  if (
    tournament.maxParticipants != null &&
    tournament.participantsCount != null &&
    tournament.participantsCount >= tournament.maxParticipants
  ) {
    return "Лист ожидания";
  }
  return "Есть места";
}

function getRegistrationText(registration: TournamentRegistrationState | null) {
  if (!registration || registration.status === "NONE") return null;
  if (registration.status === "REGISTERED") {
    return registration.placeNumber
      ? `Вы записаны, место ${registration.placeNumber}`
      : "Вы записаны на турнир";
  }
  return registration.waitlistNumber
    ? `Вы в листе ожидания, позиция ${registration.waitlistNumber}`
    : "Вы в листе ожидания";
}

function sortTournaments(items: TournamentSignupSummary[]) {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.startsAt || "");
    const rightTs = Date.parse(right.startsAt || "");
    const safeLeft = Number.isFinite(leftTs) ? leftTs : Number.MAX_SAFE_INTEGER;
    const safeRight = Number.isFinite(rightTs) ? rightTs : Number.MAX_SAFE_INTEGER;
    return safeLeft - safeRight;
  });
}

export default function TournamentSignupPage({
  onBack,
  initialTournamentId,
  initialDate,
}: TournamentSignupPageProps) {
  const { isAuthenticated } = useAuth();
  const dates = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    return Array.from({ length: DAYS_BEFORE_TODAY + DAYS_AFTER_TODAY + 1 }).map((_, index) => {
      const next = new Date(base);
      next.setDate(base.getDate() + index - DAYS_BEFORE_TODAY);
      return next;
    });
  }, []);
  const initialDateKey = getDateFromInput(initialDate);
  const initialDateIndex = dates.findIndex((date) => formatDate(date) === initialDateKey);

  const [dateIndex, setDateIndex] = useState(initialDateIndex >= 0 ? initialDateIndex : DAYS_BEFORE_TODAY);
  const [items, setItems] = useState<TournamentSignupSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialTournamentId ?? null);
  const [detail, setDetail] = useState<TournamentSignupDetail | null>(null);
  const [registration, setRegistration] = useState<TournamentRegistrationState | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDate = dates[dateIndex] ?? dates[DAYS_BEFORE_TODAY] ?? new Date();
  const selectedDateStr = formatDate(selectedDate);
  const selectedTournament = selectedId
    ? items.find((item) => item.id === selectedId) ?? detail
    : null;

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    const result = await apiFetchTournamentSignupList({ date: selectedDateStr });
    if (result.error) {
      setError(result.error.message || "Не удалось загрузить турниры");
      setItems([]);
    } else {
      setItems(sortTournaments(result.data ?? []));
    }
    setLoadingList(false);
  }, [selectedDateStr]);

  const loadDetail = useCallback(async (tournamentId: string) => {
    setLoadingDetail(true);
    setError(null);
    const detailResult = await apiFetchTournamentSignupDetail(tournamentId);
    const registrationResult = isAuthenticated
      ? await apiFetchTournamentMyRegistration(tournamentId)
      : null;

    if (detailResult.error) {
      setError(detailResult.error.message || "Не удалось открыть турнир");
      setDetail(null);
    } else {
      setDetail(detailResult.data ?? null);
    }
    setRegistration(registrationResult?.data ?? detailResult.data?.registration ?? null);
    setLoadingDetail(false);
  }, [isAuthenticated]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setRegistration(null);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    if (!isAuthenticated || !selectedId) return;
    void loadDetail(selectedId);
  }, [isAuthenticated, loadDetail, selectedId]);

  const performRegister = async () => {
    if (!selectedId || actionLoading) return;
    setActionLoading(true);
    setError(null);
    const result = await apiRegisterForTournament(selectedId);
    if (result.error) {
      setError(result.error.message || "Не удалось записаться");
    } else {
      setRegistration(result.data ?? null);
      await loadDetail(selectedId);
      await loadList();
    }
    setActionLoading(false);
  };

  const handleRegister = async () => {
    if (!isAuthenticated) {
      setAuthRequired(true);
      setError(null);
      return;
    }
    await performRegister();
  };

  const handleCancel = async () => {
    if (!selectedId || actionLoading) return;
    if (!isAuthenticated) {
      setAuthRequired(true);
      setError(null);
      return;
    }
    const accepted = window.confirm("Отменить запись на турнир?");
    if (!accepted) return;

    setActionLoading(true);
    setError(null);
    const result = await apiCancelTournamentRegistration(selectedId);
    if (result.error) {
      setError(result.error.message || "Не удалось отменить запись");
    } else {
      setRegistration(result.data ?? null);
      await loadDetail(selectedId);
      await loadList();
    }
    setActionLoading(false);
  };

  const registrationText = getRegistrationText(registration);
  const registrationStatusText = isAuthenticated
    ? (registrationText || "Вы пока не записаны")
    : "Войдите, чтобы увидеть вашу запись";
  const canCancel = Boolean(registration?.canCancel && registration.status !== "NONE");
  const canRegister =
    !canCancel &&
    detail?.status !== "CANCELLED" &&
    detail?.status !== "CLOSED" &&
    registration?.canRegister !== false;

  return (
    <div className="tournament-signup-page">
      <header className="tournament-signup-header">
        <button className="page-back" onClick={selectedId ? () => setSelectedId(null) : onBack} type="button">
          ← Назад
        </button>
        <div>
          <div className="page-title">Запись на турниры</div>
          <div className="tournament-signup-subtitle">PadelHub</div>
        </div>
      </header>

      {!selectedId && (
        <section className="tournament-signup-section">
          <div className="date-row tournament-signup-dates">
            {dates.map((date, index) => {
              const active = index === dateIndex;
              return (
                <button
                  className={`tournament-signup-date${active ? " is-active" : ""}`}
                  key={date.toISOString()}
                  type="button"
                  onClick={() => setDateIndex(index)}
                >
                  <span>{date.toLocaleDateString("ru-RU", { weekday: "short" })}</span>
                  <strong>{date.toLocaleDateString("ru-RU", { day: "2-digit" })}</strong>
                  <span>{date.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "")}</span>
                </button>
              );
            })}
          </div>

          <div className="tournament-signup-section-head">
            <h1>{getDateLabel(selectedDateStr)}</h1>
            <button className="tournament-signup-ghost" type="button" onClick={() => void loadList()}>
              Обновить
            </button>
          </div>

          {loadingList && <div className="tournament-signup-muted">Загрузка...</div>}
          {!loadingList && error && <div className="tournament-signup-error">{error}</div>}
          {!loadingList && !error && items.length === 0 && (
            <div className="tournament-signup-muted">На выбранную дату турниров нет</div>
          )}

          <div className="tournament-signup-list">
            {items.map((tournament) => (
              <button
                className="tournament-signup-card"
                key={tournament.id}
                type="button"
                onClick={() => setSelectedId(tournament.id)}
              >
                <div className="tournament-signup-card-main">
                  <span className="tournament-signup-status">{getStatusLabel(tournament)}</span>
                  <h2>{tournament.title}</h2>
                  <div className="tournament-signup-meta">
                    <span>{tournament.timeLabel}</span>
                    {tournament.studioName && <span>{tournament.studioName}</span>}
                    {tournament.format && <span>{tournament.format}</span>}
                  </div>
                  {tournament.address && <div className="tournament-signup-address">{tournament.address}</div>}
                </div>
                <div className="tournament-signup-card-side">
                  <strong>
                    {tournament.participantsCount ?? 0}
                    {tournament.maxParticipants != null ? `/${tournament.maxParticipants}` : ""}
                  </strong>
                  <span>мест</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {selectedId && (
        <section className="tournament-signup-section tournament-signup-detail">
          {authRequired && (
            <div className="tournament-signup-auth">
              <div className="tournament-signup-auth-head">
                <strong>Вход для записи</strong>
                <button className="tournament-signup-ghost" type="button" onClick={() => setAuthRequired(false)}>
                  Закрыть
                </button>
              </div>
              <AuthForm
                onLogin={() => {
                  setAuthRequired(false);
                  void performRegister();
                }}
              />
            </div>
          )}
          {loadingDetail && <div className="tournament-signup-muted">Загрузка турнира...</div>}
          {!loadingDetail && error && <div className="tournament-signup-error">{error}</div>}
          {!loadingDetail && selectedTournament && (
            <>
              <div className="tournament-signup-detail-head">
                <span className="tournament-signup-status">{getStatusLabel(selectedTournament)}</span>
                <h1>{selectedTournament.title}</h1>
                <div className="tournament-signup-meta">
                  <span>{getDateLabel(selectedTournament.date)}</span>
                  <span>{selectedTournament.timeLabel}</span>
                </div>
              </div>

              <div className="tournament-signup-facts">
                {selectedTournament.studioName && <div><span>Клуб</span><strong>{selectedTournament.studioName}</strong></div>}
                {selectedTournament.address && <div><span>Адрес</span><strong>{selectedTournament.address}</strong></div>}
                {selectedTournament.format && <div><span>Формат</span><strong>{selectedTournament.format}</strong></div>}
                {selectedTournament.levelLabel && <div><span>Уровень</span><strong>{selectedTournament.levelLabel}</strong></div>}
                {selectedTournament.priceLabel && <div><span>Стоимость</span><strong>{selectedTournament.priceLabel}</strong></div>}
                {detail?.trainerName && <div><span>Тренер</span><strong>{detail.trainerName}</strong></div>}
              </div>

              {detail?.description && <p className="tournament-signup-copy">{detail.description}</p>}
              {detail?.rules && <p className="tournament-signup-copy">{detail.rules}</p>}

              <div className="tournament-signup-registration">
                <div>
                  <span>Статус записи</span>
                  <strong>{registrationStatusText}</strong>
                  {registration?.message && <p>{registration.message}</p>}
                </div>
                <div>
                  <span>Участники</span>
                  <strong>
                    {selectedTournament.participantsCount ?? 0}
                    {selectedTournament.maxParticipants != null ? `/${selectedTournament.maxParticipants}` : ""}
                  </strong>
                  {selectedTournament.waitlistCount != null && <p>В ожидании: {selectedTournament.waitlistCount}</p>}
                </div>
              </div>

              <div className="tournament-signup-actions">
                {canRegister && (
                  <button className="section-cta" type="button" onClick={() => void handleRegister()} disabled={actionLoading}>
                    {actionLoading ? "Записываем..." : "Записаться"}
                  </button>
                )}
                {canCancel && (
                  <button className="tournament-signup-danger" type="button" onClick={() => void handleCancel()} disabled={actionLoading}>
                    {actionLoading ? "Отменяем..." : "Отменить запись"}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

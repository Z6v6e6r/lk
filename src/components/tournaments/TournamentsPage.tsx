import { useEffect, useMemo, useState } from "react";
import { Modal } from "../UI/Modal";
import {
  apiCreateAmericanoTournament,
  apiFetchExercisesByDate,
  apiFetchProfile,
  apiFetchTournamentParticipants,
} from "../../utils/apiClient";
import type { Exercise, ExerciseBooking, UserProfileType } from "../../utils/apiClient";
import { TENANT_KEY } from "../../consts/api_config";

interface TournamentsPageProps {
  onBack: () => void;
}

const TOURNAMENT_DIRECTION_ID = 2617;

const TOURNAMENT_TYPES = [
  { id: "americano", label: "Американо" },
  { id: "mexicano", label: "Мексикано" },
];

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(timeStr?: string) {
  return timeStr ? timeStr.slice(11, 16) : "";
}

function getClientName(booking: ExerciseBooking, index: number) {
  const client = booking.client as ExerciseBooking["client"] | undefined;
  const parts = [client?.firstName, client?.lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return `Участник ${index + 1}`;
}

function getInitials(booking: ExerciseBooking) {
  const client = booking.client as ExerciseBooking["client"] | undefined;
  const first = client?.firstName?.[0] || "";
  const last = client?.lastName?.[0] || "";
  return (first + last).toUpperCase() || "U";
}

type ParticipantEntry = {
  id: string;
  name: string;
  photo?: string | null;
  phone?: string | null;
  spot?: number | null;
  rating?: string | null;
};

function parseRatingValue(value: string | number | null | undefined) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = value.replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRating(value: number) {
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface TournamentDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  tournament: Exercise | null;
}

function TournamentDetailsModal({ isOpen, onClose, tournament }: TournamentDetailsModalProps) {
  const [loading, setLoading] = useState(false);
  const [participants, setParticipants] = useState<ExerciseBooking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [courtsCount, setCourtsCount] = useState("");
  const [courtNames, setCourtNames] = useState<string[]>([]);
  const [targetScore, setTargetScore] = useState(21);
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [manualRatings, setManualRatings] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!selectedType) {
      setCourtsCount("");
      setCourtNames([]);
      setTargetScore(21);
      setSaveState("idle");
      setManualRatings({});
    }
  }, [selectedType]);

  const handleCourtsCountChange = (value: string) => {
    setCourtsCount(value);
    const parsed = Number.parseInt(value, 10);
    const count = Number.isFinite(parsed) ? Math.max(0, Math.min(12, parsed)) : 0;
    setCourtNames((prev) =>
      Array.from({ length: count }, (_, idx) => prev[idx] ?? `Корт №${idx + 1}`),
    );
  };

  useEffect(() => {
    if (!isOpen) return;
    apiFetchProfile().then((res) => {
      if (res.data) setProfile(res.data);
    });
  }, [isOpen]);

  const handleSaveAmericano = async () => {
    if (!tournament) return;
    setSaveState("loading");
    const payload = {
      tournamentId: String(tournament.id),
      tenantKey: TENANT_KEY,
      createdAt: new Date().toISOString(),
      organizer: {
        id: profile?.id ?? null,
        phone: profile?.phone ?? null,
        tenantKey: TENANT_KEY,
      },
      tournamentType: "americano" as const,
      targetScore,
      courts: courtNames,
      participants: sortedParticipants
        .map((participant, idx) => {
          const manualRating = manualRatings[participant.id];
          const ratingValue = parseRatingValue(manualRating ?? participant.rating);
          return {
            id: participant.id ?? null,
            phone: participant.phone ?? null,
            rating: ratingValue != null ? String(ratingValue) : null,
            photo: participant.photo ?? null,
            name: participant.name || `Участник ${idx + 1}`,
          };
        }),
    };

    const res = await apiCreateAmericanoTournament(payload);
    if (res.data) setSaveState("success");
    else setSaveState("error");
  };

  useEffect(() => {
    if (!isOpen || !tournament) return;
    setLoading(true);
    setError(null);
    apiFetchTournamentParticipants(String(tournament.id))
      .then((res) => {
        const data = res.data as unknown;
        const list = Array.isArray(data)
          ? data
          : Array.isArray((data as { payload?: ExerciseBooking[] })?.payload)
            ? (data as { payload: ExerciseBooking[] }).payload
            : Array.isArray((data as { content?: ExerciseBooking[] })?.content)
              ? (data as { content: ExerciseBooking[] }).content
              : [];
        setParticipants(list);
      })
      .catch(() => setError("Не удалось загрузить участников"))
      .finally(() => setLoading(false));
  }, [isOpen, tournament?.id]);

  const title = tournament?.direction?.name || tournament?.type?.name || "Турнир";
  const trainer = tournament?.trainers?.[0];

  const participantEntries = useMemo((): ParticipantEntry[] => {
    return participants.map((participant, idx) => ({
      id: participant.client?.id ?? participant.id ?? `participant-${idx}`,
      name: getClientName(participant, idx),
      photo: participant.client?.photo ?? null,
      phone: participant.client?.phone ?? null,
      spot: participant.spot ?? null,
      rating: participant.rating ?? null,
    }));
  }, [participants]);

  const sortedParticipants = useMemo(() => {
    return [...participantEntries].sort((a, b) => {
      const aManual = manualRatings[a.id];
      const bManual = manualRatings[b.id];
      const aRating = parseRatingValue(aManual ?? a.rating);
      const bRating = parseRatingValue(bManual ?? b.rating);
      if (aRating == null && bRating == null) return 0;
      if (aRating == null) return 1;
      if (bRating == null) return -1;
      return bRating - aRating;
    });
  }, [participantEntries, manualRatings]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="tournaments-body">
        <div className="tournament-row">
          <span>{formatTime(tournament?.timeFrom)} – {formatTime(tournament?.timeTo)}</span>
          {tournament?.studio?.name && <span>{tournament.studio.name}</span>}
        </div>
        {tournament?.studio?.address && (
          <div className="tournament-address">{tournament.studio.address}</div>
        )}

        {trainer && (
          <div className="tournament-section">
            <div className="tournament-section-title">Исполнитель</div>
            <div className="tournament-participant tournament-trainer-card">
              <div className="tournament-participant-avatar">
                {trainer.photo ? (
                  <img
                    src={trainer.photo}
                    alt={trainer.firstName}
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <span>{getInitials({ client: { firstName: trainer.firstName, lastName: trainer.lastName } } as ExerciseBooking)}</span>
                )}
                <span className="tournament-participant-initials">
                  {getInitials({ client: { firstName: trainer.firstName, lastName: trainer.lastName } } as ExerciseBooking)}
                </span>
              </div>
              <div className="tournament-participant-info">
                <div className="tournament-participant-name">
                  {[trainer.firstName, trainer.lastName].filter(Boolean).join(" ") || "Тренер"}
                </div>
                <div className="tournament-participant-spot">Исполнитель</div>
              </div>
              <div className="tournament-participant-rating trainer">Тренер</div>
            </div>
          </div>
        )}

        <div className="tournament-section">
          <div className="tournament-section-title">Участники</div>
          {loading && <div className="tournaments-muted">Загрузка...</div>}
          {!loading && error && <div className="tournaments-error">{error}</div>}
          {!loading && !error && participants.length === 0 && (
            <div className="tournaments-muted">Участников пока нет</div>
          )}
          {!loading && !error && sortedParticipants.length > 0 && (
            <div className="tournament-participants">
              {sortedParticipants.map((participant, idx) => {
                const initials = participant.name
                  .split(" ")
                  .map((part) => part[0] || "")
                  .join("")
                  .toUpperCase()
                  .slice(0, 2) || "U";
                const manualRating = manualRatings[participant.id];
                const ratingValue = parseRatingValue(manualRating ?? participant.rating);
                const hasRating = ratingValue != null;

                return (
                  <div key={participant.id ?? idx} className="tournament-participant">
                    <div className={`tournament-participant-avatar ${participant.photo ? "" : "no-photo"}`}>
                      {participant.photo ? (
                        <img
                          src={participant.photo}
                          alt={participant.name}
                          onError={(e) => {
                            const target = e.currentTarget;
                            target.style.display = "none";
                            const parent = target.parentElement;
                            if (parent) parent.classList.add("no-photo");
                          }}
                        />
                      ) : null}
                      <span className="tournament-participant-initials">{initials}</span>
                    </div>
                    <div className="tournament-participant-info">
                      <div className="tournament-participant-name">{participant.name}</div>
                    </div>
                    {hasRating ? (
                      <div className="tournament-participant-rating">
                        {formatRating(ratingValue!)}
                      </div>
                    ) : (
                      <input
                        className="tournament-participant-rating-input"
                        type="text"
                        inputMode="decimal"
                        placeholder={participant.phone || "Рейтинг"}
                        value={manualRating ?? ""}
                        onChange={(e) =>
                          setManualRatings((prev) => ({
                            ...prev,
                            [participant.id]: e.target.value,
                          }))
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="tournament-section">
          <div className="tournament-section-title">Тип турнира</div>
          <div className="tournament-type-list">
            {TOURNAMENT_TYPES.map((type) => (
              <button
                key={type.id}
                className={`tournament-type-option ${selectedType === type.id ? "active" : ""}`}
                type="button"
                onClick={() => setSelectedType(type.id)}
              >
                {type.label}
              </button>
            ))}
          </div>
        </div>

        {selectedType && (
          <div className="tournament-section">
            {selectedType === "americano" && (
              <div className="tournament-inline-field">
                <div className="tournament-section-title">
                  До какого суммарного счета играть матчи
                </div>
                <input
                  className="tournament-input"
                  type="number"
                  min={1}
                  placeholder="21"
                  value={targetScore}
                  onChange={(e) =>
                    setTargetScore(Math.max(1, Number.parseInt(e.target.value || "0", 10)))
                  }
                />
              </div>
            )}
            <div className="tournament-section-title">Сколько кортов используем</div>
            <input
              className="tournament-input"
              type="number"
              min={1}
              max={12}
              placeholder="Например, 2"
              value={courtsCount}
              onChange={(e) => handleCourtsCountChange(e.target.value)}
            />

            {courtNames.length > 0 && (
              <div className="tournament-courts">
                {courtNames.map((name, idx) => (
                  <div key={`court-${idx}`} className="tournament-court-row">
                    <input
                      className="tournament-input"
                      type="text"
                      value={name}
                      onChange={(e) => {
                        const next = [...courtNames];
                        next[idx] = e.target.value;
                        setCourtNames(next);
                      }}
                    />
                  </div>
                ))}
              </div>
            )}

            {courtNames.length > 0 && (
              <button
                className="section-cta"
                type="button"
                onClick={selectedType === "americano" ? handleSaveAmericano : undefined}
                disabled={saveState === "loading" || selectedType !== "americano"}
              >
                {saveState === "loading"
                  ? "Сохранение..."
                  : saveState === "success"
                    ? "Сохранено"
                    : "Сохранить"}
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function TournamentsPage({ onBack }: TournamentsPageProps) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Exercise[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedTournament, setSelectedTournament] = useState<Exercise | null>(null);

  const todayStr = useMemo(() => formatDate(new Date()), []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    apiFetchExercisesByDate(todayStr)
      .then((res) => {
        if (res.data) setItems(res.data);
        else setItems([]);
      })
      .catch(() => setError("Не удалось загрузить список турниров"))
      .finally(() => setLoading(false));
  }, [todayStr]);

  const tournaments = items.filter((ex) =>
    ex.direction?.id === TOURNAMENT_DIRECTION_ID || ex.type?.id === TOURNAMENT_DIRECTION_ID,
  );

  return (
    <div className="app-container">
      <div className="page-header">
        <button className="page-back" onClick={onBack} type="button">← Назад</button>
        <div className="page-title">Турниры</div>
      </div>

      <div className="section">
        <div className="section-header">
          <span className="section-title">Турниры на сегодня</span>
        </div>
        <div className="section-body tournaments-body">
          {loading && <div className="tournaments-muted">Загрузка...</div>}
          {!loading && error && <div className="tournaments-error">{error}</div>}
          {!loading && !error && tournaments.length === 0 && (
            <div className="tournaments-muted">На сегодня турниров нет</div>
          )}
          {!loading && !error && tournaments.length > 0 && (
            <div className="tournaments-list">
              {tournaments.map((ex) => (
                <button
                  className="tournament-card"
                  key={ex.id}
                  type="button"
                  onClick={() => setSelectedTournament(ex)}
                >
                  <div className="tournament-title">{ex.direction?.name || ex.type?.name || "Турнир"}</div>
                  <div className="tournament-row">
                    <span>{formatTime(ex.timeFrom)} – {formatTime(ex.timeTo)}</span>
                    {ex.studio?.name && <span>{ex.studio.name}</span>}
                  </div>
                  {ex.trainers?.[0] && (
                    <div className="tournament-trainer">
                      Исполнитель: {ex.trainers[0].firstName} {ex.trainers[0].lastName}
                    </div>
                  )}
                  {ex.studio?.address && (
                    <div className="tournament-address">{ex.studio.address}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <TournamentDetailsModal
        isOpen={Boolean(selectedTournament)}
        onClose={() => setSelectedTournament(null)}
        tournament={selectedTournament}
      />
    </div>
  );
}

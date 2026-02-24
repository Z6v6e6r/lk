import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../UI/Modal";
import {
  apiCreateAmericanoTournament,
  apiFetchExercisesByDate,
  apiFetchProfile,
  apiFetchTournamentParticipants,
  getServ2Origin,
  apiUpdateAmericanoResults,
} from "../../utils/apiClient";
import type {
  AmericanoTournamentPayload,
  AmericanoResultsResponse,
  Exercise,
  ExerciseBooking,
  UserProfileType,
} from "../../utils/apiClient";
import { TENANT_KEY } from "../../consts/api_config";

interface TournamentsPageProps {
  onBack: () => void;
}

const TOURNAMENT_DIRECTION_ID = 2617;

const TOURNAMENT_TYPES = [
  { id: "americano", label: "Американо" },
  { id: "mexicano", label: "Мексикано" },
];

const HTML_TO_IMAGE_CDN =
  "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.min.js";

type HtmlToImageApi = {
  toPng: (node: HTMLElement, options?: Record<string, unknown>) => Promise<string>;
  toJpeg: (node: HTMLElement, options?: Record<string, unknown>) => Promise<string>;
};

declare global {
  interface Window {
    htmlToImage?: HtmlToImageApi;
  }
}

function loadHtmlToImage(): Promise<HtmlToImageApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("html-to-image unavailable"));
  }
  if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = HTML_TO_IMAGE_CDN;
    script.async = true;
    script.onload = () => {
      if (window.htmlToImage) resolve(window.htmlToImage);
      else reject(new Error("html-to-image not loaded"));
    };
    script.onerror = () => reject(new Error("failed to load html-to-image"));
    document.head.appendChild(script);
  });
}

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

function getInitialsFromName(name?: string | null) {
  if (!name) return "U";
  const parts = name.split(" ").filter(Boolean);
  const initials = parts.map((part) => part[0] || "").join("").slice(0, 2);
  return initials.toUpperCase() || "U";
}

type ParticipantEntry = {
  id: string;
  name: string;
  photo?: string | null;
  phone?: string | null;
  spot?: number | null;
  rating?: string | null;
};

type TournamentMatch = {
  id: string;
  court: string;
  pair1: ParticipantEntry[];
  pair2: ParticipantEntry[];
  score1: number | null;
  score2: number | null;
  saved?: boolean;
};

type TournamentRound = {
  id: string;
  index: number;
  matches: TournamentMatch[];
  collapsed: boolean;
  saved: boolean;
};

function parseRatingValue(value: string | number | null | undefined) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = value.replace(",", ".").trim();
  const digits = normalized.replace(/\D/g, "");
  if (digits.length >= 10) return null; // похоже на телефон
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 10) return null;
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRating(value: number) {
  return value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function toNumberSafe(value: unknown, fallback = 0) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

interface TournamentDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  tournament: Exercise | null;
  onSaved: (data: AmericanoTournamentPayload) => void;
}

function TournamentDetailsModal({ isOpen, onClose, tournament, onSaved }: TournamentDetailsModalProps) {
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
    const digits = value.replace(/[^\d]/g, "");
    const parsed = digits ? Number.parseInt(digits, 10) : 0;
    const count = Math.max(0, Math.min(12, parsed));
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
    const participantsForRounds: ParticipantEntry[] = sortedParticipants.map((participant, idx) => {
      const manualRating = manualRatings[participant.id];
      const ratingValue = parseRatingValue(manualRating ?? participant.rating);
      return {
        id: participant.id ?? participant.phone ?? `participant-${idx}`,
        name: participant.name || `Участник ${idx + 1}`,
        photo: participant.photo ?? null,
        phone: participant.phone ?? null,
        rating: ratingValue != null ? String(ratingValue) : null,
      };
    });

    const roundsForServer = generateAmericanoRounds(participantsForRounds, courtNames).map((round) => ({
      id: round.id,
      index: round.index,
      matches: round.matches.map((match) => ({
        id: match.id,
        court: match.court,
        pair1: match.pair1.map((p) => p.id),
        pair2: match.pair2.map((p) => p.id),
        score1: match.score1,
        score2: match.score2,
      })),
    }));

    const payload: AmericanoTournamentPayload = {
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
      participants: participantsForRounds.map((participant) => ({
        id: participant.id ?? null,
        phone: participant.phone ?? null,
        rating: participant.rating ?? null,
        photo: participant.photo ?? null,
        name: participant.name,
      })),
      rounds: roundsForServer,
    };

    const res = await apiCreateAmericanoTournament(payload);
    if (res.data) {
      setSaveState("success");
      onSaved(payload);
      onClose();
    } else {
      setSaveState("error");
    }
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
              onInput={(e) => handleCourtsCountChange((e.target as HTMLInputElement).value)}
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

function generateAmericanoRounds(
  participants: ParticipantEntry[],
  courts: string[],
): TournamentRound[] {
  const players = [...participants];
  if (players.length < 4) return [];
  const matchesPerRound = Math.min(courts.length, Math.floor(players.length / 4));
  if (matchesPerRound < 1) return [];
  const playersPerRound = matchesPerRound * 4;
  const roundsCount = players.length % 2 === 0 ? players.length - 1 : players.length;
  const rounds: TournamentRound[] = [];

  let order = [...players];
  for (let r = 0; r < roundsCount; r += 1) {
    const roundPlayers = order.slice(0, playersPerRound);
    const matches: TournamentMatch[] = [];
    for (let m = 0; m < matchesPerRound; m += 1) {
      const idx = m * 4;
      const block = roundPlayers.slice(idx, idx + 4);
      if (block.length < 4) break;
      matches.push({
        id: `round-${r + 1}-match-${m + 1}`,
        court: courts[m] ?? `Корт №${m + 1}`,
        pair1: [block[0], block[1]],
        pair2: [block[2], block[3]],
        score1: null,
        score2: null,
        saved: false,
      });
    }
    rounds.push({
      id: `round-${r + 1}`,
      index: r + 1,
      matches,
      collapsed: r !== 0,
      saved: false,
    });

    if (order.length > 2) {
      const fixed = order[0];
      const rest = order.slice(1);
      rest.unshift(rest.pop() as ParticipantEntry);
      order = [fixed, ...rest];
    }
  }

  return rounds;
}

function TournamentManagerModal({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: AmericanoTournamentPayload | null;
}) {
  const [activeTab, setActiveTab] = useState<"tournament" | "table" | "stats">("tournament");
  const [rounds, setRounds] = useState<TournamentRound[]>([]);
  const statsRef = useRef<HTMLDivElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [savingMatchId, setSavingMatchId] = useState<string | null>(null);
  const [matchSaveErrors, setMatchSaveErrors] = useState<Record<string, string>>({});
  const [serverTotals, setServerTotals] = useState<AmericanoResultsResponse["totals"] | null>(null);
  const [serverLogs, setServerLogs] = useState<AmericanoResultsResponse["playerLogs"] | null>(null);

  const normalizedParticipants = useMemo<ParticipantEntry[]>(() => {
    if (!data) return [];
    return data.participants.map((p, idx) => ({
      id: p.id ?? p.phone ?? `participant-${idx}`,
      name: p.name || `Участник ${idx + 1}`,
      photo: p.photo ?? null,
      phone: p.phone ?? null,
      rating: p.rating ?? null,
    }));
  }, [data]);

  useEffect(() => {
    if (!data) return;
    setRounds(generateAmericanoRounds(normalizedParticipants, data.courts));
    setActiveTab("tournament");
    setServerTotals(null);
    setServerLogs(null);
    setMatchSaveErrors({});
  }, [data, normalizedParticipants]);

  const handleScoreChange = (
    roundId: string,
    matchId: string,
    field: "score1" | "score2",
    value: string,
  ) => {
    if (!data) return;
    const parsed = value === "" ? null : Math.max(0, Math.min(data.targetScore, Number.parseInt(value, 10) || 0));
    setRounds((prev) =>
      prev.map((round) => {
        if (round.id !== roundId) return round;
        const nextMatches = round.matches.map((match) => {
          if (match.id !== matchId) return match;
          if (parsed == null) {
            return { ...match, score1: null, score2: null, saved: false };
          }
          if (field === "score1") {
            return { ...match, score1: parsed, score2: data.targetScore - parsed, saved: false };
          }
          return { ...match, score2: parsed, score1: data.targetScore - parsed, saved: false };
        });
        return {
          ...round,
          saved: nextMatches.every((m) => m.saved),
          matches: nextMatches,
        };
      }),
    );
  };

  const handleMatchSave = (roundId: string, matchId: string) => {
    if (!data) return;
    const round = rounds.find((r) => r.id === roundId);
    if (!round) return;
    const match = round.matches.find((m) => m.id === matchId);
    if (!match || match.score1 == null || match.score2 == null) {
      setMatchSaveErrors((prev) => ({
        ...prev,
        [matchId]: "Заполните результаты",
      }));
      return;
    }

    const results = [
      {
        roundId,
        matchId,
        score1: match.score1 as number,
        score2: match.score2 as number,
        pair1: match.pair1.map((p) => p.id),
        pair2: match.pair2.map((p) => p.id),
      },
    ];

    setSavingMatchId(matchId);
    setMatchSaveErrors((prev) => {
      const next = { ...prev };
      delete next[matchId];
      return next;
    });
    apiUpdateAmericanoResults({
      tournamentId: data.tournamentId,
      results,
    })
      .then((res) => {
        if (res.data) {
          setRounds((prev) =>
            prev.map((r) => {
              if (r.id !== roundId) return r;
              const updatedMatches = r.matches.map((m) =>
                m.id === matchId ? { ...m, saved: true } : m,
              );
              return {
                ...r,
                matches: updatedMatches,
                saved: updatedMatches.every((m) => m.saved),
              };
            }),
          );
          if (res.data.totals) {
            setServerTotals(res.data.totals);
          }
          if (res.data.playerLogs) {
            setServerLogs(res.data.playerLogs);
          }
        } else {
          setMatchSaveErrors((prev) => ({
            ...prev,
            [matchId]: res.error?.message || "Не удалось сохранить результаты",
          }));
        }
      })
      .catch(() =>
        setMatchSaveErrors((prev) => ({
          ...prev,
          [matchId]: "Не удалось сохранить результаты",
        })),
      )
      .finally(() => setSavingMatchId(null));
  };

  const tableStats = useMemo(() => {
    const map: Record<string, { name: string; pointsFor: number; pointsAgainst: number }> = {};
    normalizedParticipants.forEach((p) => {
      map[p.id] = { name: p.name, pointsFor: 0, pointsAgainst: 0 };
    });

    rounds.forEach((round) => {
      round.matches.forEach((match) => {
        if (match.score1 == null || match.score2 == null) return;
        match.pair1.forEach((p) => {
          const key = p.id || p.phone || p.name;
          if (!map[key]) return;
          map[key].pointsFor += match.score1!;
          map[key].pointsAgainst += match.score2!;
        });
        match.pair2.forEach((p) => {
          const key = p.id || p.phone || p.name;
          if (!map[key]) return;
          map[key].pointsFor += match.score2!;
          map[key].pointsAgainst += match.score1!;
        });
      });
    });

    return map;
  }, [normalizedParticipants, rounds]);

  const hasServerTotals = useMemo(() => {
    if (!serverTotals) return false;
    const totals = Object.values(serverTotals);
    if (!totals.length) return false;
    return totals.some((total) => {
      const pointsFor = toNumberSafe(total?.pointsFor ?? 0);
      const pointsAgainst = toNumberSafe(total?.pointsAgainst ?? 0);
      const delta = Math.abs(toNumberSafe(total?.deltaTotal ?? 0));
      const wins = toNumberSafe(total?.wins ?? 0);
      const losses = toNumberSafe(total?.losses ?? 0);
      const draws = toNumberSafe(total?.draws ?? 0);
      return pointsFor + pointsAgainst + delta + wins + losses + draws > 0;
    });
  }, [serverTotals]);

  const tableRows = useMemo(() => {
    const rows = normalizedParticipants.map((p) => {
      const totals = serverTotals?.[p.id];
      const localStats = tableStats[p.id] || { pointsFor: 0, pointsAgainst: 0 };
      const pointsFor = totals && hasServerTotals ? toNumberSafe(totals.pointsFor) : localStats.pointsFor;
      const pointsAgainst =
        totals && hasServerTotals ? toNumberSafe(totals.pointsAgainst) : localStats.pointsAgainst;
      const pointsDiff = pointsFor - pointsAgainst;
      const ratingDelta = totals && hasServerTotals ? toNumberSafe(totals.deltaTotal ?? 0) : 0;
      return {
        id: p.id,
        name: p.name,
        pointsDiff,
        ratingDelta,
        hasTotals: Boolean(totals) && hasServerTotals,
      };
    });

    return rows.sort((a, b) => {
      if (a.hasTotals && b.hasTotals) {
        return b.ratingDelta - a.ratingDelta;
      }
      return b.pointsDiff - a.pointsDiff;
    });
  }, [normalizedParticipants, tableStats, serverTotals, hasServerTotals]);

  const splitName = (name: string) => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      return { line1: name, line2: "" };
    }
    return { line1: parts[0], line2: parts.slice(1).join(" ") };
  };

  const historyRows = useMemo(() => {
    if (!serverLogs) return [];
    const rows: Array<{
      playerId: string;
      playerName: string;
      roundId?: string;
      matchId?: string;
      scoreFor?: number;
      scoreAgainst?: number;
      delta?: number;
      ratingBefore?: number;
      ratingAfter?: number;
      expected?: number;
      actual?: number;
    }> = [];
    Object.entries(serverLogs).forEach(([playerId, logs]) => {
      const player = normalizedParticipants.find((p) => p.id === playerId);
      const playerName = player?.name ?? playerId;
      const logList = Array.isArray(logs) ? logs : [];
      logList.forEach((log) => {
        rows.push({
          playerId,
          playerName,
          roundId: log.roundId,
          matchId: log.matchId,
          scoreFor: toNumberSafe(log.scoreFor),
          scoreAgainst: toNumberSafe(log.scoreAgainst),
          delta: toNumberSafe(log.delta),
          ratingBefore: toNumberSafe(log.ratingBefore),
          ratingAfter: toNumberSafe(log.ratingAfter),
          expected: toNumberSafe(log.expected),
          actual: toNumberSafe(log.actual),
        });
      });
    });
    return rows;
  }, [serverLogs, normalizedParticipants]);

  const handleExportHistory = (format: "csv" | "xlsx") => {
    if (!data?.tournamentId) return;
    const base = getServ2Origin();
    const url = `${base}/lk/tournaments/americano/history/export?tournamentId=${encodeURIComponent(
      data.tournamentId,
    )}&format=${format}`;
    window.open(url, "_blank");
  };

  const stats = useMemo(() => {
    if (!data) return [];
    const map: Record<
      string,
      {
        id: string;
        name: string;
        photo?: string | null;
        wins: number;
        draws: number;
        losses: number;
        games: number;
        pointsFor: number;
        pointsAgainst: number;
      }
    > = {};

    normalizedParticipants.forEach((p, idx) => {
      const key = p.id ?? `participant-${idx}`;
      map[key] = {
        id: key,
        name: p.name || `Участник ${idx + 1}`,
        photo: p.photo ?? null,
        wins: 0,
        draws: 0,
        losses: 0,
        games: 0,
        pointsFor: 0,
        pointsAgainst: 0,
      };
    });

    rounds.forEach((round) => {
      round.matches.forEach((match) => {
        if (match.score1 == null || match.score2 == null) return;
        const pair1Result =
          match.score1 > match.score2 ? "win" : match.score1 < match.score2 ? "loss" : "draw";
        const pair2Result =
          match.score2 > match.score1 ? "win" : match.score2 < match.score1 ? "loss" : "draw";

        match.pair1.forEach((p) => {
          const key = p.id || p.phone || p.name;
          if (!map[key]) return;
          map[key].games += 1;
          map[key].pointsFor += match.score1 ?? 0;
          map[key].pointsAgainst += match.score2 ?? 0;
          if (pair1Result === "win") map[key].wins += 1;
          else if (pair1Result === "loss") map[key].losses += 1;
          else map[key].draws += 1;
        });

        match.pair2.forEach((p) => {
          const key = p.id || p.phone || p.name;
          if (!map[key]) return;
          map[key].games += 1;
          map[key].pointsFor += match.score2 ?? 0;
          map[key].pointsAgainst += match.score1 ?? 0;
          if (pair2Result === "win") map[key].wins += 1;
          else if (pair2Result === "loss") map[key].losses += 1;
          else map[key].draws += 1;
        });
      });
    });

    return Object.values(map).sort((a, b) => {
      const diffA = a.pointsFor - a.pointsAgainst;
      const diffB = b.pointsFor - b.pointsAgainst;
      if (diffB !== diffA) return diffB - diffA;
      return b.pointsFor - a.pointsFor;
    });
  }, [data, rounds]);

  const statsRows = useMemo(() => {
    if (serverTotals && hasServerTotals) {
      return normalizedParticipants
        .map((p) => {
          const total = serverTotals[p.id];
          return {
            id: p.id,
            name: p.name,
            photo: p.photo ?? null,
            wins: toNumberSafe(total?.wins ?? 0),
            losses: toNumberSafe(total?.losses ?? 0),
            draws: toNumberSafe(total?.draws ?? 0),
            pointsFor: toNumberSafe(total?.pointsFor ?? 0),
            pointsAgainst: toNumberSafe(total?.pointsAgainst ?? 0),
          };
        })
        .sort((a, b) => {
          const diffA = a.pointsFor - a.pointsAgainst;
          const diffB = b.pointsFor - b.pointsAgainst;
          if (diffB !== diffA) return diffB - diffA;
          return b.pointsFor - a.pointsFor;
        });
    }
    return stats;
  }, [serverTotals, normalizedParticipants, stats, hasServerTotals]);

  const handleExportStats = async (format: "png" | "jpeg") => {
    if (!statsRef.current || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const { toPng, toJpeg } = await loadHtmlToImage();
      const node = statsRef.current;
      const commonOptions = {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#fff",
        skipFonts: true,
      };
      const dataUrl =
        format === "png"
          ? await toPng(node, commonOptions)
          : await toJpeg(node, { ...commonOptions, quality: 0.95 });
      const link = document.createElement("a");
      link.download = `americano-stats.${format === "png" ? "png" : "jpg"}`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error(err);
      setExportError("Не удалось сохранить изображение. Проверьте доступ к CDN.");
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen || !data) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Американо">
      <div className="tournament-manager">
        <div className="tournament-tabs">
          {[
            { key: "tournament", label: "Турнир" },
            { key: "table", label: "Таблица" },
            { key: "stats", label: "Статистика" },
          ].map((tab) => (
            <button
              key={tab.key}
              className={`tournament-tab ${activeTab === tab.key ? "active" : ""}`}
              type="button"
              onClick={() => setActiveTab(tab.key as typeof activeTab)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "tournament" && (
          <div className="tournament-rounds">
            {rounds.map((round) => (
              <div
                key={round.id}
                className={`tournament-round ${round.saved ? "saved" : "unsaved"}`}
              >
                <button
                  type="button"
                  className="tournament-round-header"
                  onClick={() =>
                    setRounds((prev) =>
                      prev.map((r) =>
                        r.id === round.id ? { ...r, collapsed: !r.collapsed } : r,
                      ),
                    )
                  }
                >
                  <span className="tournament-round-title">Раунд {round.index}</span>
                  <div className="tournament-round-actions">
                    {Object.keys(matchSaveErrors).some((id) =>
                      round.matches.some((m) => m.id === id),
                    ) ? (
                      <span className="tournament-round-status error">Ошибка</span>
                    ) : round.saved ? (
                      <span className="tournament-round-status saved">Сохранено</span>
                    ) : null}
                    {round.saved && (
                      <span className="tournament-round-edit" title="Редактировать">
                        ✎
                      </span>
                    )}
                    <span>{round.collapsed ? "+" : "−"}</span>
                  </div>
                </button>
                {!round.collapsed && (
                  <div className="tournament-round-body">
                    {round.matches.map((match) => (
                      <div key={match.id} className="tournament-match">
                        <div className="tournament-match-row">
                          <span className="tournament-match-label">Корт</span>
                          <span className="tournament-match-value">{match.court}</span>
                        </div>
                        <div className="tournament-match-row">
                          <span className="tournament-match-label">Пара 1</span>
                          <span className="tournament-match-value">
                            {match.pair1.map((p) => p.name).join(" + ")}
                          </span>
                          <input
                            className="tournament-score-input"
                            type="number"
                            min={0}
                            max={data.targetScore}
                            value={match.score1 ?? ""}
                            onChange={(e) =>
                              handleScoreChange(round.id, match.id, "score1", e.target.value)
                            }
                          />
                        </div>
                        <div className="tournament-match-row">
                          <span className="tournament-match-label">Пара 2</span>
                          <span className="tournament-match-value">
                            {match.pair2.map((p) => p.name).join(" + ")}
                          </span>
                          <input
                            className="tournament-score-input"
                            type="number"
                            min={0}
                            max={data.targetScore}
                            value={match.score2 ?? ""}
                            onChange={(e) =>
                              handleScoreChange(round.id, match.id, "score2", e.target.value)
                            }
                          />
                        </div>
                        <div className="tournament-match-actions">
                          <div className="tournament-match-status">
                            {matchSaveErrors[match.id] ? (
                              <span className="tournament-round-status error">Ошибка</span>
                            ) : match.saved ? (
                              <span className="tournament-round-status saved">Сохранено</span>
                            ) : null}
                          </div>
                          <button
                            className="tournament-round-save"
                            type="button"
                            onClick={() => handleMatchSave(round.id, match.id)}
                            disabled={savingMatchId === match.id}
                          >
                            {savingMatchId === match.id ? "Сохранение..." : "Сохранить"}
                          </button>
                        </div>
                        {matchSaveErrors[match.id] && (
                          <div className="tournaments-error">{matchSaveErrors[match.id]}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === "table" && (
          <div className="tournament-table">
            {tableRows.map((row) => {
              const name = splitName(row.name);
              const diffClass =
                row.pointsDiff > 0
                  ? "positive"
                  : row.pointsDiff < 0
                    ? "negative"
                    : "";
              const deltaClass =
                row.ratingDelta > 0
                  ? "positive"
                  : row.ratingDelta < 0
                    ? "negative"
                    : "";
              return (
                <div key={row.id} className="tournament-table-row">
                  <div className="tournament-table-name">
                    <span className="tournament-table-name-line">{name.line1}</span>
                    {name.line2 && (
                      <span className="tournament-table-name-line secondary">{name.line2}</span>
                    )}
                  </div>
                  <div className="tournament-table-metrics">
                    <div className="tournament-table-metric">
                      <span className="tournament-table-metric-label">Разница</span>
                      <span className={`tournament-table-metric-value ${diffClass}`}>
                        {row.pointsDiff > 0 ? `+${row.pointsDiff}` : row.pointsDiff}
                      </span>
                    </div>
                    <div className="tournament-table-metric">
                      <span className="tournament-table-metric-label">Δ рейтинг</span>
                      <span className={`tournament-table-metric-value ${deltaClass}`}>
                        {row.ratingDelta > 0
                          ? `+${row.ratingDelta.toFixed(5)}`
                          : row.ratingDelta.toFixed(5)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeTab === "stats" && (
          <div className="tournament-stats">
            <div className="tournament-stats-actions">
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => handleExportStats("png")}
                disabled={exporting}
              >
                PNG
              </button>
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => handleExportStats("jpeg")}
                disabled={exporting}
              >
                JPEG
              </button>
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => handleExportHistory("csv")}
              >
                CSV
              </button>
              <button
                className="tournament-stats-export"
                type="button"
                onClick={() => handleExportHistory("xlsx")}
              >
                XLSX
              </button>
              {exportError && <span className="tournament-stats-error">{exportError}</span>}
            </div>
            <div className="tournament-stats-capture" ref={statsRef}>
              <div className="tournament-stats-header">
                <span>Участник</span>
                <span>Игры</span>
                <span>Очки</span>
                <span>Разница</span>
              </div>
              {statsRows.map((row) => {
                const diff = row.pointsFor - row.pointsAgainst;
                return (
                  <div key={row.id} className="tournament-stats-row">
                    <div className="tournament-stats-player">
                      <div className={`tournament-participant-avatar ${row.photo ? "" : "no-photo"}`}>
                        {row.photo ? (
                          <img
                            src={row.photo}
                            alt={row.name}
                            crossOrigin="anonymous"
                            onError={(e) => {
                              const target = e.currentTarget;
                              target.style.display = "none";
                              const parent = target.parentElement;
                              if (parent) parent.classList.add("no-photo");
                            }}
                          />
                        ) : null}
                        <span className="tournament-participant-initials">
                          {getInitialsFromName(row.name)}
                        </span>
                      </div>
                      <span className="tournament-stats-name">{row.name}</span>
                    </div>
                    <div className="tournament-stats-record">
                      <span className="tournament-stats-loss">{row.losses}</span>
                      <span className="tournament-stats-sep">-</span>
                      <span className="tournament-stats-draw">{row.draws}</span>
                      <span className="tournament-stats-sep">-</span>
                      <span className="tournament-stats-win">{row.wins}</span>
                    </div>
                    <div className="tournament-stats-points">
                      {row.pointsAgainst} - {row.pointsFor}
                    </div>
                    <div
                      className={`tournament-stats-diff ${
                        diff > 0 ? "positive" : diff < 0 ? "negative" : ""
                      }`}
                    >
                      {diff > 0 ? `+${diff}` : diff}
                    </div>
                  </div>
                );
              })}
            </div>
            {historyRows.length > 0 && (
              <div className="tournament-history">
                <div className="tournament-history-title">История матчей</div>
                {historyRows.map((row, idx) => (
                  <div key={`${row.playerId}-${row.matchId}-${idx}`} className="tournament-history-row">
                    <span className="tournament-history-name">{row.playerName}</span>
                    <span className="tournament-history-round">
                      {row.roundId} / {row.matchId}
                    </span>
                    <span className="tournament-history-score">
                      {row.scoreFor} - {row.scoreAgainst}
                    </span>
                    <span
                      className={`tournament-history-delta ${
                        (row.delta ?? 0) > 0 ? "positive" : (row.delta ?? 0) < 0 ? "negative" : ""
                      }`}
                    >
                      {row.delta != null ? row.delta.toFixed(5) : "0.00000"}
                    </span>
                    <span className="tournament-history-rating">
                      {row.ratingBefore != null ? row.ratingBefore.toFixed(5) : "0.00000"} →{" "}
                      {row.ratingAfter != null ? row.ratingAfter.toFixed(5) : "0.00000"}
                    </span>
                  </div>
                ))}
              </div>
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
  const [managerData, setManagerData] = useState<AmericanoTournamentPayload | null>(null);

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
        onSaved={(data) => setManagerData(data)}
      />

      <TournamentManagerModal
        isOpen={Boolean(managerData)}
        onClose={() => setManagerData(null)}
        data={managerData}
      />
    </div>
  );
}

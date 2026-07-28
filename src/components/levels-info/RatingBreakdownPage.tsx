import { useMemo, useState } from "react";
import type { RatingBreakdownDefaultTab, RatingBreakdownPayload } from "../../types/levelsInfoOverlay";
import { AvatarImageOrInitials } from "../cabinet/community-feed/AvatarImageOrInitials";
import { COMMUNITY_RATING_CALCULATION_VERSION } from "../../services/community-rating/contract";
import {
  ACTIVITY_FACTOR_WEIGHTS,
  OVERALL_FACTOR_WEIGHTS,
  buildActivityFactorRows,
  buildGamesFactorRows,
  buildOverallFactorRows,
  buildTournamentFactorRows,
  calculateActivityScoreFromFactors,
  calculateGamesRawScoreFromFactors,
  calculateOverallScoreFromFactors,
  calculateTournamentRawScoreFromFactors,
  getExpectedGamesReliabilityFactor,
  getExpectedTournamentReliabilityFactor,
  getGamesReliabilityHint,
  getTournamentReliabilityHint,
} from "./ratingBreakdownUtils";
import "./RatingBreakdownPage.css";

interface RatingBreakdownPageProps {
  onBack: () => void;
  payload: RatingBreakdownPayload;
}

function roundTo(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatNumber(value: number, minDigits = 1, maxDigits = minDigits): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toLocaleString("ru-RU", {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
  });
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "Данные актуальны: время обновления недоступно";
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return "Данные актуальны: время обновления недоступно";
  const date = new Date(ts);
  const dateText = date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const timeText = date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Данные актуальны на ${dateText}, ${timeText}`;
}

function getBallsLabel(value: number): string {
  const safe = Math.abs(Math.round(value));
  const last = safe % 10;
  const lastTwo = safe % 100;
  if (last === 1 && lastTwo !== 11) return "балл";
  if (last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14)) return "балла";
  return "баллов";
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M15 6L9 12L15 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 7L17 17" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M17 7L7 17" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="8.2" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="10" cy="6" r="1.1" fill="currentColor" />
      <path d="M10 9V14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function TabGamesIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none">
      <path d="M5.25 6.5H7.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.5 5.25V7.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10.7" cy="6.2" r="0.95" fill="currentColor" />
      <circle cx="12.35" cy="7.75" r="0.95" fill="currentColor" />
      <path d="M4.7 4H11.3C13.3 4 14.2 5.05 14.2 7.1V8.9C14.2 10.95 13.3 12 11.3 12H4.7C2.7 12 1.8 10.95 1.8 8.9V7.1C1.8 5.05 2.7 4 4.7 4Z" stroke="currentColor" strokeWidth="1.35" />
    </svg>
  );
}

function TabOverallIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none">
      <rect x="2" y="8.5" width="2.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6.75" y="5.5" width="2.5" height="8.5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11.5" y="2.5" width="2.5" height="11.5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ScoreOverallIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="2.8" fill="currentColor" />
      <path d="M12 3V5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 19V21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 12H5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M19 12H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ScoreGamesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path d="M6 16L10.2 11.8L13 14.6L18 9.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.8 9.6H18V12.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path d="M8 4H16V8.5C16 10.98 13.98 13 11.5 13H12.5C10.02 13 8 10.98 8 8.5V4Z" fill="currentColor" />
      <path d="M6 6H8V8.2C8 9.48 6.98 10.5 5.7 10.5H5C4.45 10.5 4 10.05 4 9.5V8C4 6.9 4.9 6 6 6Z" fill="currentColor" />
      <path d="M18 6H16V8.2C16 9.48 17.02 10.5 18.3 10.5H19C19.55 10.5 20 10.05 20 9.5V8C20 6.9 19.1 6 18 6Z" fill="currentColor" />
      <path d="M10 13H14V15.5C14 16.6 13.1 17.5 12 17.5C10.9 17.5 10 16.6 10 15.5V13Z" fill="currentColor" />
      <rect x="8" y="18" width="8" height="2" rx="1" fill="currentColor" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path d="M12 3L14.58 8.22L20.35 9.06L16.18 13.12L17.16 18.86L12 16.15L6.84 18.86L7.82 13.12L3.65 9.06L9.42 8.22L12 3Z" fill="currentColor" />
    </svg>
  );
}

function TrendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path d="M5 16L10 11L13 14L18.5 8.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.8 8.5H18.5V11.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BarsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <rect x="4" y="11" width="3.5" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
      <rect x="10.25" y="7" width="3.5" height="12" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
      <rect x="16.5" y="4" width="3.5" height="15" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none">
      <path d="M19.2 8.5A8.3 8.3 0 0 0 5.4 6.2" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M18.4 3.7V8.8H13.3" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.8 15.5A8.3 8.3 0 0 0 18.6 17.8" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <path d="M5.6 20.3V15.2H10.7" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none">
      <path d="M7 4L13 10L7 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function getOverallWeightBadge(id: "gamesNormalized" | "tournamentNormalized" | "activityScore") {
  if (id === "gamesNormalized") {
    return { label: `${Math.round(OVERALL_FACTOR_WEIGHTS.games * 100)}%`, tone: "violet" as const };
  }
  if (id === "tournamentNormalized") {
    return { label: `${Math.round(OVERALL_FACTOR_WEIGHTS.tournaments * 100)}%`, tone: "pink" as const };
  }
  return { label: `${Math.round(OVERALL_FACTOR_WEIGHTS.activity * 100)}%`, tone: "orange" as const };
}

function getOverallRowIcon(id: "gamesNormalized" | "tournamentNormalized" | "activityScore") {
  if (id === "gamesNormalized") {
    return {
      className: "rating-breakdown-list-icon rating-breakdown-list-icon--violet",
      icon: <TabGamesIcon />,
    };
  }
  if (id === "tournamentNormalized") {
    return {
      className: "rating-breakdown-list-icon rating-breakdown-list-icon--pink",
      icon: <TrophyIcon />,
    };
  }
  return {
    className: "rating-breakdown-list-icon rating-breakdown-list-icon--orange",
    icon: <ActivityIcon />,
  };
}

function getGamesRowIcon(id: "gamesWon" | "setsWon" | "gamesWonCount" | "gamesDiff" | "levelDelta") {
  if (id === "gamesWon") {
    return {
      className: "rating-breakdown-list-icon rating-breakdown-list-icon--violet",
      icon: <TrophyIcon />,
    };
  }
  if (id === "setsWon") {
    return {
      className: "rating-breakdown-list-icon rating-breakdown-list-icon--pink",
      icon: <TabGamesIcon />,
    };
  }
  if (id === "gamesWonCount") {
    return {
      className: "rating-breakdown-list-icon rating-breakdown-list-icon--blue",
      icon: <StarIcon />,
    };
  }
  if (id === "gamesDiff") {
    return {
      className: "rating-breakdown-list-icon rating-breakdown-list-icon--orange",
      icon: <TrendIcon />,
    };
  }
  return {
    className: "rating-breakdown-list-icon rating-breakdown-list-icon--green",
    icon: <BarsIcon />,
  };
}

function getTournamentRowIcon(id: "placement" | "matchesWon" | "pointsScored" | "pointsDiff") {
  if (id === "placement") {
    return { className: "rating-breakdown-list-icon rating-breakdown-list-icon--pink", icon: <TrophyIcon /> };
  }
  if (id === "matchesWon") {
    return { className: "rating-breakdown-list-icon rating-breakdown-list-icon--violet", icon: <TrendIcon /> };
  }
  if (id === "pointsScored") {
    return { className: "rating-breakdown-list-icon rating-breakdown-list-icon--blue", icon: <StarIcon /> };
  }
  return { className: "rating-breakdown-list-icon rating-breakdown-list-icon--orange", icon: <BarsIcon /> };
}

function getActivityRowIcon(id: "games" | "tournaments" | "visits") {
  if (id === "games") {
    return { className: "rating-breakdown-list-icon rating-breakdown-list-icon--violet", icon: <TabGamesIcon /> };
  }
  if (id === "tournaments") {
    return { className: "rating-breakdown-list-icon rating-breakdown-list-icon--pink", icon: <TrophyIcon /> };
  }
  return { className: "rating-breakdown-list-icon rating-breakdown-list-icon--orange", icon: <ActivityIcon /> };
}

export function RatingBreakdownPage({
  onBack,
  payload,
}: RatingBreakdownPageProps) {
  const [activeTab, setActiveTab] = useState<RatingBreakdownDefaultTab>(payload.defaultTab);
  const metrics = payload.metrics;
  const gamesFactorRows = useMemo(() => buildGamesFactorRows(metrics), [metrics]);
  const overallFactorRows = useMemo(() => buildOverallFactorRows(metrics), [metrics]);
  const tournamentFactorRows = useMemo(() => buildTournamentFactorRows(metrics), [metrics]);
  const activityFactorRows = useMemo(() => buildActivityFactorRows(metrics), [metrics]);

  const calculatedRawScore = useMemo(() => calculateGamesRawScoreFromFactors(metrics), [metrics]);
  const rawScore = Number.isFinite(metrics.gamesRawScore) ? metrics.gamesRawScore : calculatedRawScore;
  const expectedReliability = getExpectedGamesReliabilityFactor(metrics.gamesPlayed);
  const reliabilityFactor = Number.isFinite(metrics.gamesReliabilityFactor)
    ? metrics.gamesReliabilityFactor
    : expectedReliability;
  const finalGamesScore = roundTo(rawScore * reliabilityFactor);

  const calculatedOverallScore = useMemo(() => calculateOverallScoreFromFactors(metrics), [metrics]);
  const overallScore = Number.isFinite(metrics.overallScore) ? metrics.overallScore : calculatedOverallScore;
  const calculatedTournamentRawScore = useMemo(
    () => calculateTournamentRawScoreFromFactors(metrics),
    [metrics],
  );
  const tournamentRawScore = Number.isFinite(metrics.tournamentRawScore)
    ? metrics.tournamentRawScore
    : calculatedTournamentRawScore;
  const expectedTournamentReliability = getExpectedTournamentReliabilityFactor(metrics.tournamentsPlayed);
  const tournamentReliabilityFactor = Number.isFinite(metrics.tournamentReliabilityFactor)
    ? metrics.tournamentReliabilityFactor
    : expectedTournamentReliability;
  const finalTournamentScore = roundTo(tournamentRawScore * tournamentReliabilityFactor);
  const calculatedActivityScore = useMemo(() => calculateActivityScoreFromFactors(metrics), [metrics]);
  const activityScore = Number.isFinite(metrics.activityScore) ? metrics.activityScore : calculatedActivityScore;
  const activityRawScore = activityFactorRows.reduce((sum, row) => sum + row.contribution, 0);

  if (payload.calculationVersion !== COMMUNITY_RATING_CALCULATION_VERSION) {
    return (
      <div className="rating-breakdown-layout">
        <header className="rating-breakdown-topbar">
          <button
            type="button"
            className="rating-breakdown-icon-button"
            aria-label="Назад"
            onClick={onBack}
          >
            <BackIcon />
          </button>
          <h1 className="rating-breakdown-title">Разбор рейтинга</h1>
          <button
            type="button"
            className="rating-breakdown-icon-button"
            aria-label="Закрыть"
            onClick={onBack}
          >
            <CloseIcon />
          </button>
        </header>
        <section className="rating-breakdown-card" role="status">
          <h2 className="rating-breakdown-card-title">Рейтинг обновляется</h2>
          <p className="rating-breakdown-note">
            Новая формула ещё не загружена. Закройте окно и попробуйте снова через минуту.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="rating-breakdown-layout">
      <header className="rating-breakdown-topbar">
        <button
          type="button"
          className="rating-breakdown-icon-button"
          aria-label="Назад"
          onClick={onBack}
        >
          <BackIcon />
        </button>
        <h1 className="rating-breakdown-title">Разбор рейтинга</h1>
        <button
          type="button"
          className="rating-breakdown-icon-button"
          aria-label="Закрыть"
          onClick={onBack}
        >
          <CloseIcon />
        </button>
      </header>

      <section className="rating-breakdown-player">
        <div className="rating-breakdown-avatar">
          <AvatarImageOrInitials
            src={payload.player.avatarUrl ?? undefined}
            name={payload.player.name}
            imageClassName="rating-breakdown-avatar-image"
          />
        </div>
        <div className="rating-breakdown-player-copy">
          <div className="rating-breakdown-player-name">{payload.player.name}</div>
          <div className="rating-breakdown-player-badges">
            <span className="rating-breakdown-rank">#{payload.player.rank}</span>
            {payload.player.isCurrentUser && <span className="rating-breakdown-self">Моя позиция</span>}
          </div>
        </div>
      </section>

      <div className="rating-breakdown-tabs" role="tablist" aria-label="Режим разбора рейтинга">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "games"}
          className={`rating-breakdown-tab${activeTab === "games" ? " is-active" : ""}`}
          onClick={() => setActiveTab("games")}
        >
          <TabGamesIcon />
          <span>Игры</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "tournaments"}
          className={`rating-breakdown-tab${activeTab === "tournaments" ? " is-active" : ""}`}
          onClick={() => setActiveTab("tournaments")}
        >
          <TrophyIcon />
          <span>Турниры</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "activity"}
          className={`rating-breakdown-tab${activeTab === "activity" ? " is-active" : ""}`}
          onClick={() => setActiveTab("activity")}
        >
          <ActivityIcon />
          <span>Активность</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "overall"}
          className={`rating-breakdown-tab${activeTab === "overall" ? " is-active" : ""}`}
          onClick={() => setActiveTab("overall")}
        >
          <TabOverallIcon />
          <span>Общий</span>
        </button>
      </div>

      {activeTab === "overall" ? (
        <>
          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Общий рейтинг</h2>
            <div className="rating-breakdown-score-row">
              <div className="rating-breakdown-score-icon" aria-hidden="true">
                <ScoreOverallIcon />
              </div>
              <div className="rating-breakdown-score-value">{formatNumber(overallScore, 1, 1)}</div>
            </div>
            <div className="rating-breakdown-note">
              Общий рейтинг = Игры × {formatNumber(OVERALL_FACTOR_WEIGHTS.games, 2, 2)} + Турниры × {formatNumber(OVERALL_FACTOR_WEIGHTS.tournaments, 2, 2)} + Активность × {formatNumber(OVERALL_FACTOR_WEIGHTS.activity, 2, 2)}
            </div>
            <div className="rating-breakdown-updated">
              <InfoIcon />
              <span>{formatUpdatedAt(payload.updatedAt)}</span>
            </div>
          </section>

          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Из чего складывается общий рейтинг</h2>
            <div className="rating-breakdown-list-shell">
              {overallFactorRows.map((row) => {
                const badge = getOverallWeightBadge(row.id);
                const iconMeta = getOverallRowIcon(row.id);

                return (
                  <div key={row.id} className="rating-breakdown-list-row">
                    <div className={iconMeta.className}>{iconMeta.icon}</div>
                    <div className="rating-breakdown-list-copy">
                      <div className="rating-breakdown-list-title">{row.title}</div>
                      <div className="rating-breakdown-list-subtitle">{formatNumber(row.value, 0, 1)} {getBallsLabel(row.value)}</div>
                      <div className="rating-breakdown-list-formula">{formatNumber(row.value, 0, 1)} × {formatNumber(row.multiplier, 2, 2)}</div>
                    </div>
                    <div className="rating-breakdown-list-math">
                      <strong>{formatNumber(row.contribution, 1, 1)}</strong>
                      <span className={`rating-breakdown-weight-badge rating-breakdown-weight-badge--${badge.tone}`}>{badge.label}</span>
                    </div>
                  </div>
                );
              })}
              <div className="rating-breakdown-total-box">
                <span>Итоговый общий рейтинг</span>
                <strong>{formatNumber(overallScore, 1, 1)}</strong>
              </div>
            </div>
            <div className="rating-breakdown-soft-note">
              <div className="rating-breakdown-soft-note-icon"><InfoIcon /></div>
              <div>
                <div>Общий рейтинг рассчитывается по нормализованным значениям.</div>
                <div>Каждый компонент имеет свой вес в формуле.</div>
              </div>
            </div>
          </section>

          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Подробнее о компонентах</h2>
            <div className="rating-breakdown-details-list">
              <div className="rating-breakdown-details-row">
                <div className="rating-breakdown-list-icon rating-breakdown-list-icon--violet"><TabGamesIcon /></div>
                <div className="rating-breakdown-details-copy">
                  <div className="rating-breakdown-details-title">Нормализованный рейтинг игр</div>
                  <div className="rating-breakdown-details-text">Ваш игровой рейтинг переводится в шкалу 0-100 относительно лучшего результата в сообществе</div>
                </div>
                <span className="rating-breakdown-details-arrow"><ChevronIcon /></span>
              </div>

              <div className="rating-breakdown-details-row">
                <div className="rating-breakdown-list-icon rating-breakdown-list-icon--pink"><TrophyIcon /></div>
                <div className="rating-breakdown-details-copy">
                  <div className="rating-breakdown-details-title">Нормализованный рейтинг турниров</div>
                  <div className="rating-breakdown-details-text">Ваш турнирный рейтинг переводится в шкалу 0-100 относительно лучшего результата в сообществе</div>
                </div>
                <span className="rating-breakdown-details-arrow"><ChevronIcon /></span>
              </div>

              <div className="rating-breakdown-details-row">
                <div className="rating-breakdown-list-icon rating-breakdown-list-icon--orange"><ActivityIcon /></div>
                <div className="rating-breakdown-details-copy">
                  <div className="rating-breakdown-details-title">Активность</div>
                  <div className="rating-breakdown-details-text">Учитывает регулярность игры и участие в жизни сообщества</div>
                </div>
                <span className="rating-breakdown-details-arrow"><ChevronIcon /></span>
              </div>
            </div>
          </section>

          <div className="rating-breakdown-footnote">
            <InfoIcon />
            <span>Рейтинг обновляется после каждой завершенной игры или турнира</span>
          </div>
        </>
      ) : activeTab === "games" ? (
        <>
          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Рейтинг в играх</h2>
            <div className="rating-breakdown-score-row">
              <div className="rating-breakdown-score-icon" aria-hidden="true">
                <ScoreGamesIcon />
              </div>
              <div className="rating-breakdown-score-value">{formatNumber(metrics.gamesScore, 1, 1)}</div>
            </div>
            <div className="rating-breakdown-note">Рейтинг по играм = Сумма факторов × Коэффициент надежности</div>
            <div className="rating-breakdown-updated">
              <InfoIcon />
              <span>{formatUpdatedAt(payload.updatedAt)}</span>
            </div>
          </section>

          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Из чего складывается рейтинг</h2>
            <div className="rating-breakdown-list-shell">
              {gamesFactorRows.map((row) => {
                const iconMeta = getGamesRowIcon(row.id);
                return (
                  <div key={row.id} className="rating-breakdown-list-row">
                    <div className={iconMeta.className}>{iconMeta.icon}</div>
                    <div className="rating-breakdown-list-copy">
                      <div className="rating-breakdown-list-title">{row.title} × {formatNumber(row.multiplier, 0, 2)}</div>
                      <div className="rating-breakdown-list-subtitle">{row.subtitle}</div>
                    </div>
                    <div className="rating-breakdown-list-math">
                      <div className="rating-breakdown-list-formula">{formatNumber(row.value, 0, 3)} × {formatNumber(row.multiplier, 0, 2)}</div>
                      <strong>{formatNumber(row.contribution, 1, 1)}</strong>
                    </div>
                  </div>
                );
              })}
              <div className="rating-breakdown-total-box">
                <span>Сумма факторов (Raw Score)</span>
                <strong>{formatNumber(rawScore, 1, 1)}</strong>
              </div>
            </div>
          </section>

          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Коэффициент надежности</h2>
            <div className="rating-breakdown-reliability-row">
              <div className="rating-breakdown-list-icon rating-breakdown-list-icon--violet"><ScoreOverallIcon /></div>
              <div className="rating-breakdown-list-copy">
                <div className="rating-breakdown-list-title">Надежность выборки по играм</div>
                <div className="rating-breakdown-list-subtitle">{metrics.gamesPlayed} игр сыграно</div>
              </div>
              <strong className="rating-breakdown-reliability-value">× {formatNumber(reliabilityFactor, 2, 2)}</strong>
            </div>
            <div className="rating-breakdown-reliability-hint">{getGamesReliabilityHint(metrics.gamesPlayed)}</div>
            {roundTo(expectedReliability, 3) !== roundTo(reliabilityFactor, 3) && (
              <div className="rating-breakdown-reliability-warning">Для {metrics.gamesPlayed} игр ожидаемый коэффициент: × {formatNumber(expectedReliability, 2, 2)}</div>
            )}
          </section>

          <section className="rating-breakdown-card rating-breakdown-card--final">
            <div className="rating-breakdown-final-row">
              <div>
                <div className="rating-breakdown-final-title">Итоговый рейтинг в играх</div>
                <div className="rating-breakdown-final-subtitle">Raw Score × Надежность</div>
              </div>
              <div className="rating-breakdown-final-score">{formatNumber(finalGamesScore, 1, 1)}</div>
            </div>
            <div className="rating-breakdown-final-formula">
              {formatNumber(rawScore, 1, 1)} × {formatNumber(reliabilityFactor, 2, 2)} = {formatNumber(finalGamesScore, 1, 1)}
            </div>
          </section>

          <div className="rating-breakdown-footnote">
            <InfoIcon />
            <span>Рейтинг по играм обновляется после каждой завершенной игры</span>
          </div>
        </>
      ) : activeTab === "tournaments" ? (
        <>
          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Рейтинг в турнирах</h2>
            <div className="rating-breakdown-score-row">
              <div className="rating-breakdown-score-icon rating-breakdown-score-icon--tournaments" aria-hidden="true">
                <TrophyIcon />
              </div>
              <div className="rating-breakdown-score-value rating-breakdown-score-value--tournaments">
                {formatNumber(finalTournamentScore, 1, 1)}
              </div>
            </div>
            <div className="rating-breakdown-note">Рейтинг турниров = Сумма факторов × Коэффициент надежности</div>
            <div className="rating-breakdown-updated">
              <InfoIcon />
              <span>{formatUpdatedAt(payload.updatedAt)}</span>
            </div>
          </section>

          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Из чего складывается рейтинг турниров</h2>
            <div className="rating-breakdown-list-shell">
              {tournamentFactorRows.map((row) => {
                const iconMeta = getTournamentRowIcon(row.id);
                return (
                  <div key={row.id} className="rating-breakdown-list-row">
                    <div className={iconMeta.className}>{iconMeta.icon}</div>
                    <div className="rating-breakdown-list-copy">
                      <div className="rating-breakdown-list-title">{row.title} × {formatNumber(row.multiplier, 0, 2)}</div>
                      <div className="rating-breakdown-list-subtitle">{row.subtitle}</div>
                    </div>
                    <div className="rating-breakdown-list-math">
                      <div className="rating-breakdown-list-formula">{formatNumber(row.value, 0, 2)} × {formatNumber(row.multiplier, 0, 2)}</div>
                      <strong>{formatNumber(row.contribution, 1, 1)}</strong>
                    </div>
                  </div>
                );
              })}
              <div className="rating-breakdown-total-box">
                <span>Сумма факторов (Raw Score)</span>
                <strong>{formatNumber(tournamentRawScore, 1, 1)}</strong>
              </div>
            </div>
          </section>

          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Коэффициент надежности</h2>
            <div className="rating-breakdown-reliability-row">
              <div className="rating-breakdown-list-icon rating-breakdown-list-icon--pink"><TrophyIcon /></div>
              <div className="rating-breakdown-list-copy">
                <div className="rating-breakdown-list-title">Надежность выборки по турнирам</div>
                <div className="rating-breakdown-list-subtitle">{metrics.tournamentsPlayed} турниров завершено</div>
              </div>
              <strong className="rating-breakdown-reliability-value rating-breakdown-reliability-value--tournaments">
                × {formatNumber(tournamentReliabilityFactor, 2, 2)}
              </strong>
            </div>
            <div className="rating-breakdown-reliability-hint">{getTournamentReliabilityHint(metrics.tournamentsPlayed)}</div>
            {roundTo(expectedTournamentReliability, 3) !== roundTo(tournamentReliabilityFactor, 3) && (
              <div className="rating-breakdown-reliability-warning">
                Для {metrics.tournamentsPlayed} турниров ожидаемый коэффициент: × {formatNumber(expectedTournamentReliability, 2, 2)}
              </div>
            )}
          </section>

          <section className="rating-breakdown-card rating-breakdown-card--final rating-breakdown-card--final-tournaments">
            <div className="rating-breakdown-final-row">
              <div>
                <div className="rating-breakdown-final-title">Итоговый рейтинг турниров</div>
                <div className="rating-breakdown-final-subtitle">Raw Score × Надежность</div>
              </div>
              <div className="rating-breakdown-final-score">{formatNumber(finalTournamentScore, 1, 1)}</div>
            </div>
            <div className="rating-breakdown-final-formula">
              {formatNumber(tournamentRawScore, 1, 1)} × {formatNumber(tournamentReliabilityFactor, 2, 2)} = {formatNumber(finalTournamentScore, 1, 1)}
            </div>
            <div className="rating-breakdown-final-formula">
              Нормализованный результат в сообществе: {formatNumber(metrics.tournamentNormalized, 1, 1)} из 100
            </div>
          </section>

          <div className="rating-breakdown-footnote">
            <InfoIcon />
            <span>Рейтинг турниров обновляется после финализации турнирной таблицы</span>
          </div>
        </>
      ) : (
        <>
          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Активность</h2>
            <div className="rating-breakdown-score-row">
              <div className="rating-breakdown-score-icon rating-breakdown-score-icon--activity" aria-hidden="true">
                <ActivityIcon />
              </div>
              <div className="rating-breakdown-score-value rating-breakdown-score-value--activity">
                {formatNumber(activityScore, 1, 1)}
              </div>
            </div>
            <div className="rating-breakdown-note">Активность = Игры × 4 + Турниры × 12 + Посещения × 2, максимум 100</div>
            <div className="rating-breakdown-updated">
              <InfoIcon />
              <span>{formatUpdatedAt(payload.updatedAt)}</span>
            </div>
          </section>

          <section className="rating-breakdown-card">
            <h2 className="rating-breakdown-section-title">Из чего складывается активность</h2>
            <div className="rating-breakdown-list-shell">
              {activityFactorRows.map((row) => {
                const iconMeta = getActivityRowIcon(row.id);
                return (
                  <div key={row.id} className="rating-breakdown-list-row">
                    <div className={iconMeta.className}>{iconMeta.icon}</div>
                    <div className="rating-breakdown-list-copy">
                      <div className="rating-breakdown-list-title">{row.title} × {formatNumber(row.multiplier, 0, 0)}</div>
                      <div className="rating-breakdown-list-subtitle">{row.subtitle}</div>
                    </div>
                    <div className="rating-breakdown-list-math">
                      <div className="rating-breakdown-list-formula">{formatNumber(row.value, 0, 0)} × {formatNumber(row.multiplier, 0, 0)}</div>
                      <strong>{formatNumber(row.contribution, 1, 1)}</strong>
                    </div>
                  </div>
                );
              })}
              <div className="rating-breakdown-total-box">
                <span>Баллы активности до лимита</span>
                <strong>{formatNumber(activityRawScore, 1, 1)}</strong>
              </div>
            </div>
            <div className="rating-breakdown-soft-note">
              <div className="rating-breakdown-soft-note-icon"><InfoIcon /></div>
              <div>Итог ограничен значением {ACTIVITY_FACTOR_WEIGHTS.max}, чтобы один тип активности не перекрывал остальные компоненты рейтинга.</div>
            </div>
          </section>

          <section className="rating-breakdown-card rating-breakdown-card--final rating-breakdown-card--final-activity">
            <div className="rating-breakdown-final-row">
              <div>
                <div className="rating-breakdown-final-title">Итоговая активность</div>
                <div className="rating-breakdown-final-subtitle">Сумма факторов с лимитом 100</div>
              </div>
              <div className="rating-breakdown-final-score">{formatNumber(activityScore, 1, 1)}</div>
            </div>
            <div className="rating-breakdown-final-formula">
              min({formatNumber(activityRawScore, 1, 1)}, {ACTIVITY_FACTOR_WEIGHTS.max}) = {formatNumber(activityScore, 1, 1)}
            </div>
          </section>

          <div className="rating-breakdown-footnote">
            <InfoIcon />
            <span>Учитываются завершенные игры, финализированные турниры и подтвержденные посещения тренировок</span>
          </div>
        </>
      )}
    </div>
  );
}

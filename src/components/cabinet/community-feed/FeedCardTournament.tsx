import { FeedCardWrapper } from "./FeedCardWrapper";
import { formatFeedDateLabel } from "./feedFormatters";
import type { Tournament } from "./feedTypes";

interface FeedCardTournamentProps {
  tournament: Tournament;
  onOpen: () => void;
}

function getTournamentCtaLabel(tournament: Tournament) {
  if (tournament.isJoined) return "Открыть";
  if (tournament.maxParticipants > 0 && tournament.participants >= tournament.maxParticipants) {
    return "Список ожидания";
  }
  return "Участвовать";
}

function getTournamentFormat(tournament: Tournament) {
  const pairs = tournament.maxParticipants > 0 ? Math.max(1, Math.round(tournament.maxParticipants / 2)) : null;
  const segments = [
    pairs ? `${pairs} пар` : null,
    tournament.level ? `Level ${tournament.level}` : null,
  ].filter(Boolean);

  return segments.join(" • ") || "Формат уточняется";
}

export function FeedCardTournament({ tournament, onOpen }: FeedCardTournamentProps) {
  const progress = tournament.maxParticipants > 0
    ? Math.min(100, Math.round((tournament.participants / tournament.maxParticipants) * 100))
    : 0;

  return (
    <FeedCardWrapper variant="tournament">
      <div className="community-feed-card-head">
        <span className="community-feed-card-kicker">🏆 Турнир • {formatFeedDateLabel(tournament.date)}</span>
      </div>

      <div className="community-feed-card-title">{tournament.title}</div>
      <div className="community-feed-card-meta">{getTournamentFormat(tournament)}</div>

      <div className={`community-feed-media community-feed-media--tournament${tournament.media ? "" : " is-placeholder"}`}>
        {tournament.media ? (
          <img src={tournament.media} alt={tournament.title} className="community-feed-media-image" />
        ) : (
          <div className="community-feed-media-placeholder">
            <span>Турнирная сетка</span>
          </div>
        )}
      </div>

      <div className="community-feed-tournament-stats">
        <div className="community-feed-tournament-stat-row">
          <span className="community-feed-tournament-stat-label">
            {tournament.participants}/{tournament.maxParticipants}
          </span>
          <span className="community-feed-tournament-stat-value">Старт {tournament.startTime}</span>
        </div>
        <div className="community-feed-progress" aria-hidden="true">
          <span className="community-feed-progress-bar" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <button type="button" className="community-feed-cta community-feed-cta--primary" onClick={onOpen}>
        {getTournamentCtaLabel(tournament)}
      </button>
    </FeedCardWrapper>
  );
}

import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import type { CommunityRecord } from "../../../utils/communityApi";
import { CommunityBottomNav } from "./CommunityBottomNav";
import { CommunityHeader } from "./CommunityHeader";
import { CommunitySecondaryNav, type CommunitySecondaryNavItemId } from "./CommunitySecondaryNav";
import { AvatarImageOrInitials } from "./AvatarImageOrInitials";
import type { CommunityBottomNavItemId } from "./feedTypes";

type CommunityRankingPeriodId = "month" | "quarter" | "year" | "all";

interface CommunityRankingScreenRow {
  rank: number;
  id: string | null;
  phone: string | null;
  name: string;
  avatar: string | null;
  role: string;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  setsWon: number;
  setsLost: number;
  gamesWon: number;
  gamesLost: number;
  ratingDeltaSum: number;
}

interface CommunityRankingScreenProps {
  community: Pick<CommunityRecord, "name" | "logo" | "memberCount">;
  rows: CommunityRankingScreenRow[];
  currentUserRow: CommunityRankingScreenRow | null;
  activePeriod: CommunityRankingPeriodId;
  gamesCount: number;
  chatBadgeCount: number;
  isLoading: boolean;
  error: string | null;
  currentUserId: string | null;
  currentUserPhone: string | null;
  onChangePeriod: (period: CommunityRankingPeriodId) => void;
  onOpenMenu: () => void;
  onClose: () => void;
  onSelectSectionNav: (itemId: CommunitySecondaryNavItemId) => void;
  onSelectBottomNav: (itemId: CommunityBottomNavItemId) => void;
  navActionSlot?: ReactNode;
}

const PERIOD_OPTIONS: Array<{ id: CommunityRankingPeriodId; label: string }> = [
  { id: "month", label: "Месяц" },
  { id: "quarter", label: "Квартал" },
  { id: "year", label: "Год" },
  { id: "all", label: "Все время" },
];

const PERIOD_FILTER_LAYOUT_CLASS: Record<CommunityRankingPeriodId, string> = {
  month: "month",
  quarter: "quarter",
  year: "year",
  all: "all",
};

function formatSignedNumber(value: number) {
  const formatter = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  if (value > 0) return `+${formatter.format(value)}`;
  if (value < 0) return formatter.format(value);
  return "0";
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function getGamesCountLabel(value: number) {
  if (value % 10 === 1 && value % 100 !== 11) return `${value} игра`;
  if ([2, 3, 4].includes(value % 10) && ![12, 13, 14].includes(value % 100)) return `${value} игры`;
  return `${value} игр`;
}

function normalizeSearchValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

function RankingSearchIcon() {
  return (
    <svg viewBox="0 0 10 10" className="community-ranking-search-icon" aria-hidden="true" fill="none">
      <path
        d="M4.375 7.5C6.10089 7.5 7.5 6.10089 7.5 4.375C7.5 2.64911 6.10089 1.25 4.375 1.25C2.64911 1.25 1.25 2.64911 1.25 4.375C1.25 6.10089 2.64911 7.5 4.375 7.5Z"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path d="M8.75 8.75L6.5625 6.5625" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function RankingDateFilterIcon() {
  return (
    <svg viewBox="0 0 14 14" className="community-ranking-toolbar-filter-icon" aria-hidden="true" fill="none">
      <path d="M1.75 4.08325H12.25" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M3.5 7H10.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M5.83325 9.91675H8.16659" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

export function CommunityRankingScreen({
  community,
  rows,
  currentUserRow,
  activePeriod,
  gamesCount,
  chatBadgeCount,
  isLoading,
  error,
  currentUserId,
  currentUserPhone,
  onChangePeriod,
  onOpenMenu,
  onClose,
  onSelectSectionNav,
  onSelectBottomNav,
  navActionSlot,
}: CommunityRankingScreenProps) {
  const [searchValue, setSearchValue] = useState("");
  const deferredSearchValue = useDeferredValue(searchValue);
  const normalizedSearchValue = normalizeSearchValue(deferredSearchValue);
  const activePeriodOption = PERIOD_OPTIONS.find((option) => option.id === activePeriod) ?? PERIOD_OPTIONS[0];

  const filteredRows = useMemo(() => {
    if (!normalizedSearchValue) {
      return rows;
    }

    return rows.filter((row) => normalizeSearchValue(row.name).includes(normalizedSearchValue));
  }, [normalizedSearchValue, rows]);

  const handleCyclePeriod = () => {
    const currentIndex = PERIOD_OPTIONS.findIndex((option) => option.id === activePeriod);
    const nextOption = PERIOD_OPTIONS[(currentIndex + 1) % PERIOD_OPTIONS.length] ?? PERIOD_OPTIONS[0];
    onChangePeriod(nextOption.id);
  };

  return (
    <div className="community-feed-screen community-ranking-screen">
      <div className="community-feed-screen-glow" aria-hidden="true" />

      <div className="community-ranking-top-stack">
        <CommunityHeader community={community} onOpenMenu={onOpenMenu} onClose={onClose} />

        <CommunitySecondaryNav activeItem="ranking" onSelect={onSelectSectionNav} />

        <div className="community-ranking-filter-bar" aria-label="Фильтр периода рейтинга">
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`community-ranking-filter-chip community-ranking-filter-chip--${PERIOD_FILTER_LAYOUT_CLASS[option.id]}${activePeriod === option.id ? " is-active" : ""}`}
              onClick={() => onChangePeriod(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="community-ranking-toolbar">
          <label className="community-ranking-search">
            <RankingSearchIcon />
            <input
              type="search"
              className="community-ranking-search-input"
              value={searchValue}
              onChange={(event) => setSearchValue(event.target.value)}
              placeholder="Поиск игрока"
              aria-label="Поиск игрока"
            />
          </label>

          <button
            type="button"
            className={`community-ranking-toolbar-filter${activePeriod !== "all" ? " is-active" : ""}`}
            onClick={handleCyclePeriod}
            aria-label={`Период рейтинга: ${activePeriodOption.label}`}
            title={`Период рейтинга: ${activePeriodOption.label}`}
          >
            <RankingDateFilterIcon />
          </button>
        </div>
      </div>

      <section className="community-ranking-stage">
        <div className="community-ranking-stage-head">
          <div className="community-ranking-stage-copy">
            <h3 className="community-feed-section-title">Рейтинг игроков</h3>
            <p className="community-ranking-stage-caption">
              Место считается по подтвержденным матчам внутри сообщества.
            </p>
          </div>

          <div className={`community-ranking-highlight${gamesCount > 0 ? "" : " is-muted"}`}>
            {gamesCount > 0 ? getGamesCountLabel(gamesCount) : "Нет матчей"}
          </div>
        </div>

        {error && <div className="community-form-error">{error}</div>}

        {currentUserRow ? (
          <article className="community-ranking-summary-card community-ranking-summary-card--screen">
            <div className="community-ranking-summary-head">
              <div>
                <div className="community-ranking-summary-label">Моя позиция</div>
                <div className="community-ranking-summary-main">
                  <span className="community-ranking-summary-place">#{currentUserRow.rank}</span>
                  <span className="community-ranking-summary-name">{currentUserRow.name}</span>
                </div>
              </div>

              <div
                className={`community-ranking-delta${currentUserRow.ratingDeltaSum > 0 ? " is-positive" : currentUserRow.ratingDeltaSum < 0 ? " is-negative" : ""}`}
              >
                {formatSignedNumber(currentUserRow.ratingDeltaSum)}
              </div>
            </div>

            <div className="community-ranking-summary-metrics">
              <div className="community-ranking-summary-metric">
                <span className="community-ranking-summary-metric-label">Игры</span>
                <span className="community-ranking-summary-metric-value">{currentUserRow.matchesPlayed}</span>
              </div>
              <div className="community-ranking-summary-metric">
                <span className="community-ranking-summary-metric-label">Победы</span>
                <span className="community-ranking-summary-metric-value">{currentUserRow.matchesWon}</span>
              </div>
              <div className="community-ranking-summary-metric">
                <span className="community-ranking-summary-metric-label">Поражения</span>
                <span className="community-ranking-summary-metric-value">{currentUserRow.matchesLost}</span>
              </div>
              <div className="community-ranking-summary-metric">
                <span className="community-ranking-summary-metric-label">Сеты</span>
                <span className="community-ranking-summary-metric-value">
                  {currentUserRow.setsWon}:{currentUserRow.setsLost}
                </span>
              </div>
            </div>
          </article>
        ) : (
          <div className="community-empty-note">
            У тебя пока нет подтвержденных матчей в выбранном периоде.
          </div>
        )}

        {isLoading && rows.length > 0 && (
          <div className="community-ranking-status">Обновляем статистику сообщества...</div>
        )}

        {isLoading && rows.length === 0 ? (
          <div className="community-loading-note">Считаем рейтинг игроков по матчам сообщества...</div>
        ) : rows.length === 0 ? (
          <div className="community-empty-note">
            За выбранный период подтвержденных игр сообщества пока нет.
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="community-empty-note">
            Игрок по запросу не найден.
          </div>
        ) : (
          <div className="community-ranking-list">
            {filteredRows.map((row) => {
              const normalizedRowPhone = normalizePhone(row.phone);
              const isCurrentUser = Boolean(
                (row.id && currentUserId && row.id === currentUserId)
                || (normalizedRowPhone && currentUserPhone && normalizedRowPhone === currentUserPhone),
              );

              return (
                <article
                  key={`${row.id ?? row.phone ?? row.name}-${row.rank}`}
                  className={`community-ranking-card${isCurrentUser ? " is-current" : ""}`}
                >
                  <div className="community-ranking-card-head">
                    <div className="community-ranking-card-player">
                      <div className="community-ranking-rank-badge">#{row.rank}</div>

                      <div className="community-ranking-avatar community-ranking-avatar--screen">
                        <AvatarImageOrInitials src={row.avatar ?? undefined} name={row.name} imageClassName="community-ranking-avatar-image" />
                      </div>

                      <div className="community-ranking-card-copy">
                        <div className="community-ranking-name-row">
                          <span className="community-ranking-name">{row.name}</span>
                          {isCurrentUser && <span className="community-ranking-you">Вы</span>}
                        </div>
                        <div className="community-ranking-card-subline">
                          {row.matchesWon}-{row.matchesLost} по играм • {row.setsWon}-{row.setsLost} по сетам
                        </div>
                      </div>
                    </div>

                    <div
                      className={`community-ranking-delta${row.ratingDeltaSum > 0 ? " is-positive" : row.ratingDeltaSum < 0 ? " is-negative" : ""}`}
                    >
                      {formatSignedNumber(row.ratingDeltaSum)}
                    </div>
                  </div>

                  <div className="community-ranking-metrics">
                    <div className="community-ranking-metric">
                      <span className="community-ranking-metric-label">Игры</span>
                      <span className="community-ranking-metric-value">{row.matchesPlayed}</span>
                    </div>
                    <div className="community-ranking-metric">
                      <span className="community-ranking-metric-label">Выигр. игры</span>
                      <span className="community-ranking-metric-value">{row.matchesWon}</span>
                    </div>
                    <div className="community-ranking-metric">
                      <span className="community-ranking-metric-label">Проигр. игры</span>
                      <span className="community-ranking-metric-value">{row.matchesLost}</span>
                    </div>
                    <div className="community-ranking-metric">
                      <span className="community-ranking-metric-label">Выигр. сеты</span>
                      <span className="community-ranking-metric-value">{row.setsWon}</span>
                    </div>
                    <div className="community-ranking-metric">
                      <span className="community-ranking-metric-label">Проигр. сеты</span>
                      <span className="community-ranking-metric-value">{row.setsLost}</span>
                    </div>
                    <div className="community-ranking-metric">
                      <span className="community-ranking-metric-label">Выигр. геймы</span>
                      <span className="community-ranking-metric-value">{row.gamesWon}</span>
                    </div>
                    <div className="community-ranking-metric">
                      <span className="community-ranking-metric-label">Проигр. геймы</span>
                      <span className="community-ranking-metric-value">{row.gamesLost}</span>
                    </div>
                    <div className="community-ranking-metric community-ranking-metric--delta">
                      <span className="community-ranking-metric-label">Сумма рейтинга</span>
                      <span
                        className={`community-ranking-metric-value${row.ratingDeltaSum > 0 ? " is-positive" : row.ratingDeltaSum < 0 ? " is-negative" : ""}`}
                      >
                        {formatSignedNumber(row.ratingDeltaSum)}
                      </span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <CommunityBottomNav
        activeItem="table"
        chatBadgeCount={chatBadgeCount}
        onSelect={onSelectBottomNav}
        actionSlot={navActionSlot}
      />
    </div>
  );
}

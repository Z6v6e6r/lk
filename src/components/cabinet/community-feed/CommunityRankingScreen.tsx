import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { CommunityRatingPeriod, CommunityRecord } from "../../../utils/communityApi";
import { CommunityBottomNav } from "./CommunityBottomNav";
import { CommunityHeader } from "./CommunityHeader";
import { CommunitySecondaryNav, type CommunitySecondaryNavItemId } from "./CommunitySecondaryNav";
import { AvatarImageOrInitials } from "./AvatarImageOrInitials";
import type { CommunityBottomNavItemId } from "./feedTypes";
import { useStickyCurrentUserRow } from "./useStickyCurrentUserRow";
import type { CommunityRankingRowModel, CommunityRankingTypeId } from "./communityRankingModel";

interface CommunityRankingScreenProps {
  community: Pick<CommunityRecord, "name" | "logo" | "memberCount">;
  rows: CommunityRankingRowModel[];
  activeType: CommunityRankingTypeId;
  activePeriod: CommunityRatingPeriod;
  gamesCount: number;
  chatBadgeCount: number;
  isLoading: boolean;
  error: string | null;
  currentUserId: string | null;
  currentUserPhone: string | null;
  onChangeType: (type: CommunityRankingTypeId) => void;
  onChangePeriod: (period: CommunityRatingPeriod) => void;
  onOpenRatingBreakdown?: (
    row: CommunityRankingRowModel,
    source: "avatar" | "score",
  ) => void;
  onOpenMenu: () => void;
  onClose: () => void;
  onSelectSectionNav: (itemId: CommunitySecondaryNavItemId) => void;
  onSelectBottomNav: (itemId: CommunityBottomNavItemId) => void;
  navActionSlot?: ReactNode;
}

const RATING_TYPE_OPTIONS: Array<{ id: CommunityRankingTypeId; label: string }> = [
  { id: "overall", label: "Общий" },
  { id: "games", label: "Игры" },
  { id: "tournaments", label: "Турниры" },
];

const RATING_PERIOD_OPTIONS: Array<{ id: CommunityRatingPeriod; label: string; layoutClass: string }> = [
  { id: "all", label: "Все время", layoutClass: "period-all" },
  { id: "30d", label: "Месяц", layoutClass: "month" },
];

const RATING_TYPE_LAYOUT_CLASS: Record<CommunityRankingTypeId, string> = {
  overall: "month",
  dynamics: "quarter",
  games: "year",
  tournaments: "all",
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

function formatUnsignedNumber(value: number) {
  const formatter = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  if (!Number.isFinite(value)) return "0";
  return formatter.format(value);
}

function getRowScoreValue(row: CommunityRankingRowModel, activeType: CommunityRankingTypeId) {
  if (activeType === "dynamics") return formatSignedNumber(row.ratingDeltaSum);
  if (activeType === "games") return formatUnsignedNumber(row.gamesScore);
  if (activeType === "tournaments") return formatUnsignedNumber(row.tournamentScore);
  return formatUnsignedNumber(row.overallScore);
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

function RankingGamesIcon() {
  return (
    <svg viewBox="0 0 14 14" className="community-ranking-games-pill-icon" aria-hidden="true" fill="none">
      <path d="M4.25 8.25H9.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 8.25V5.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9 8.25V4.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M2.25 2.5H11.75V11.5H2.25V2.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}

function RankingOverallIcon() {
  return (
    <svg
      viewBox="0 0 10 10"
      className="community-ranking-games-pill-icon community-ranking-games-pill-icon--overall"
      aria-hidden="true"
      fill="none"
    >
      <path
        d="M5.86382 0.722089L6.74372 2.49644C6.86371 2.74343 7.18367 2.98035 7.45364 3.02572L9.04847 3.29288C10.0684 3.46426 10.3083 4.2103 9.57341 4.94625L8.33354 6.19636C8.12357 6.40807 8.00858 6.81637 8.07357 7.10873L8.42853 8.65625C8.7085 9.88115 8.06357 10.355 6.98869 9.71481L5.49386 8.82259C5.22389 8.66129 4.77894 8.66129 4.50397 8.82259L3.00913 9.71481C1.93925 10.355 1.28932 9.87611 1.56929 8.65625L1.92425 7.10873C1.98925 6.81637 1.87426 6.40807 1.66428 6.19636L0.424419 4.94625C-0.3055 4.2103 -0.0705258 3.46426 0.949361 3.29288L2.54419 3.02572C2.80916 2.98035 3.12912 2.74343 3.24911 2.49644L4.12901 0.722089C4.60896 -0.240696 5.38887 -0.240696 5.86382 0.722089Z"
        fill="currentColor"
      />
    </svg>
  );
}

function RankingFilterIcon() {
  return (
    <svg viewBox="0 0 14 14" className="community-ranking-toolbar-filter-icon" aria-hidden="true" fill="none">
      <path d="M1.75 4.08325H12.25" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M3.5 7H10.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M5.83325 9.91675H8.16659" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function RankingDeltaArrowIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 6 4" className="community-ranking-delta-arrow-icon" aria-hidden="true" fill="none">
      {direction === "up" ? (
        <path d="M3 0L6 4H0L3 0Z" fill="currentColor" />
      ) : (
        <path d="M0 0H6L3 4L0 0Z" fill="currentColor" />
      )}
    </svg>
  );
}

function RankingLeaderIcon() {
  return (
    <svg viewBox="0 0 24 19" className="community-ranking-leader-icon" aria-hidden="true" fill="none">
      <rect width="24" height="19" rx="9.5" fill="#FAFAFA" />
      <path
        d="M16.7325 6.76884L14.4663 8.30533C14.1661 8.50948 13.7355 8.38591 13.6052 8.0582L12.5344 5.35054C12.3531 4.88315 11.6563 4.88315 11.475 5.35054L10.3985 8.05283C10.2682 8.38591 9.84332 8.50948 9.54305 8.29996L7.27686 6.76347C6.82363 6.46262 6.22309 6.88703 6.41005 7.38666L8.76688 13.6454C8.8462 13.8603 9.06148 14 9.29943 14H14.6986C14.9366 14 15.1519 13.8549 15.2312 13.6454L17.588 7.38666C17.7806 6.88703 17.1801 6.46262 16.7325 6.76884ZM13.4182 11.7275H10.5855C10.3532 11.7275 10.1606 11.5448 10.1606 11.3246C10.1606 11.1043 10.3532 10.9217 10.5855 10.9217H13.4182C13.6505 10.9217 13.8431 11.1043 13.8431 11.3246C13.8431 11.5448 13.6505 11.7275 13.4182 11.7275Z"
        fill="#AACD11"
      />
    </svg>
  );
}

export function CommunityRankingScreen({
  community,
  rows,
  activeType,
  activePeriod,
  gamesCount,
  chatBadgeCount,
  isLoading,
  error,
  currentUserId,
  currentUserPhone,
  onChangeType,
  onChangePeriod,
  onOpenRatingBreakdown,
  onOpenMenu,
  onClose,
  onSelectSectionNav,
  onSelectBottomNav,
  navActionSlot,
}: CommunityRankingScreenProps) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [stickyOffsets, setStickyOffsets] = useState({ top: 0, bottom: 88 });
  const deferredSearchValue = useDeferredValue(searchValue);
  const normalizedSearchValue = normalizeSearchValue(deferredSearchValue);
  const isCurrentUserRow = useCallback((row: CommunityRankingRowModel) => {
    const normalizedRowPhone = normalizePhone(row.phone);
    return Boolean(
      (row.id && currentUserId && row.id === currentUserId)
      || (normalizedRowPhone && currentUserPhone && normalizedRowPhone === currentUserPhone),
    );
  }, [currentUserId, currentUserPhone]);

  const handleOpenRatingBreakdown = useCallback((
    row: CommunityRankingRowModel,
    source: "avatar" | "score",
  ) => {
    onOpenRatingBreakdown?.(row, source);
  }, [onOpenRatingBreakdown]);

  const filteredRows = useMemo(() => {
    if (!normalizedSearchValue) {
      return rows;
    }

    return rows.filter((row) => normalizeSearchValue(row.name).includes(normalizedSearchValue));
  }, [normalizedSearchValue, rows]);
  const currentUserRow = useMemo(
    () => filteredRows.find((row) => isCurrentUserRow(row)) ?? null,
    [filteredRows, isCurrentUserRow],
  );
  const hasCurrentUserInFilteredRows = currentUserRow != null;

  const {
    currentUserRowRef,
    stickyPosition,
    isStickyVisible,
    scrollToCurrentUser,
  } = useStickyCurrentUserRow({
    containerRef: screenRef,
    topOffset: stickyOffsets.top,
    bottomOffset: stickyOffsets.bottom,
    enabled: hasCurrentUserInFilteredRows,
  });

  const stickyStyle = useMemo(
    () => ({
      "--community-ranking-sticky-top": `${stickyOffsets.top}px`,
      "--community-ranking-sticky-bottom": `${stickyOffsets.bottom}px`,
    }) as CSSProperties,
    [stickyOffsets.bottom, stickyOffsets.top],
  );

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;

    let frameId: number | null = null;
    const updateStickyOffsets = () => {
      frameId = null;
      const nav = screen.querySelector<HTMLElement>(".community-bottom-nav");
      const nextTop = 0;
      const nextBottom = nav
        ? Math.max(8, Math.round(window.innerHeight - nav.getBoundingClientRect().top + 8))
        : 88;

      setStickyOffsets((prev) => {
        if (prev.top === nextTop && prev.bottom === nextBottom) {
          return prev;
        }
        return { top: nextTop, bottom: nextBottom };
      });
    };
    const requestUpdateOffsets = () => {
      if (frameId != null) return;
      frameId = window.requestAnimationFrame(updateStickyOffsets);
    };

    const scrollTargets: Array<EventTarget> = [window];
    let parent = screen.parentElement;
    while (parent) {
      const overflowY = window.getComputedStyle(parent).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        scrollTargets.push(parent);
      }
      parent = parent.parentElement;
    }

    requestUpdateOffsets();
    scrollTargets.forEach((target) => {
      target.addEventListener("scroll", requestUpdateOffsets, { passive: true });
    });
    window.addEventListener("resize", requestUpdateOffsets);

    return () => {
      scrollTargets.forEach((target) => {
        target.removeEventListener("scroll", requestUpdateOffsets);
      });
      window.removeEventListener("resize", requestUpdateOffsets);
      if (frameId != null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  const getDynamicsTone = (value: number) => {
    if (value > 0) return "positive";
    if (value < 0) return "negative";
    return "neutral";
  };

  return (
    <div ref={screenRef} className="community-feed-screen community-ranking-screen">
      <div className="community-feed-screen-glow" aria-hidden="true" />

      <div className="community-ranking-top-stack">
        <CommunityHeader community={community} onOpenMenu={onOpenMenu} onClose={onClose} />

        <CommunitySecondaryNav activeItem="ranking" onSelect={onSelectSectionNav} />

        <div className="community-ranking-box">
          <div className="community-ranking-filter-bar community-ranking-filter-bar--period" aria-label="Период рейтинга">
            {RATING_PERIOD_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`community-ranking-filter-chip community-ranking-filter-chip--${option.layoutClass}${activePeriod === option.id ? " is-active" : ""}`}
                onClick={() => onChangePeriod(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="community-ranking-filter-bar community-ranking-filter-bar--type" aria-label="Фильтр типа рейтинга">
            {RATING_TYPE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`community-ranking-filter-chip community-ranking-filter-chip--${RATING_TYPE_LAYOUT_CLASS[option.id]}${activeType === option.id ? " is-active" : ""}`}
                onClick={() => onChangeType(option.id)}
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
            <div className="community-ranking-toolbar-filter" aria-hidden="true">
              <RankingFilterIcon />
            </div>
          </div>
          <section className="community-ranking-stage">
            <div className="community-ranking-stage-head">
              <div className="community-ranking-stage-copy">
                <h3 className="community-feed-section-title">Рейтинг игроков</h3>
              </div>

              <div className={`community-ranking-highlight${gamesCount > 0 ? "" : " is-muted"}`}>
                {gamesCount > 0 ? getGamesCountLabel(gamesCount) : "Нет матчей"}
              </div>
            </div>

            {error && <div className="community-form-error">{error}</div>}

            {isLoading && rows.length > 0 && (
              <div className="community-ranking-status">Обновляем статистику сообщества...</div>
            )}

            {isLoading && rows.length === 0 ? (
              <div className="community-loading-note">Считаем рейтинг игроков по матчам сообщества...</div>
            ) : rows.length === 0 ? (
              <div className="community-empty-note">
                Для выбранного типа рейтинга данных пока нет.
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="community-empty-note">
                Игрок по запросу не найден.
              </div>
            ) : (
              <div className="community-ranking-list">
                {filteredRows.map((row, index) => {
                  const isCurrentUser = isCurrentUserRow(row);
                  const isLeader = row.rank === 1;
                  const dynamicsTone = activeType === "dynamics"
                    ? getDynamicsTone(row.ratingDeltaSum)
                    : null;
                  const isDynamics = activeType === "dynamics";
                  const lastRatingTone = activeType === "overall"
                    ? getDynamicsTone(row.lastRatingDelta ?? 0)
                    : null;

                  return (
                    <article
                      key={`${row.id ?? row.phone ?? row.name}-${row.rank}`}
                      ref={isCurrentUser ? currentUserRowRef : undefined}
                      className={`community-ranking-card community-ranking-card--compact${isCurrentUser ? " is-current" : ""}${isCurrentUser && isStickyVisible ? " is-hidden-while-sticky" : ""}`}
                    >
                      <div className="community-ranking-card-head">
                        <div className="community-ranking-card-player">
                          <div className={`community-ranking-rank-badge${isLeader ? " is-leader" : ""}`}>
                            {isLeader ? <RankingLeaderIcon /> : row.rank}
                          </div>

                          <button
                            type="button"
                            className="community-ranking-avatar-button"
                            aria-label={`Открыть разбор рейтинга игрока ${row.name}`}
                            onClick={() => handleOpenRatingBreakdown(row, "avatar")}
                          >
                            <div className="community-ranking-avatar community-ranking-avatar--screen">
                              <AvatarImageOrInitials src={row.avatar ?? undefined} name={row.name} imageClassName="community-ranking-avatar-image" />
                            </div>
                          </button>

                          <div className="community-ranking-card-copy">
                            <div className="community-ranking-name-row">
                              <span className="community-ranking-name">{row.name}</span>
                              {isCurrentUser && <span className="community-ranking-you">Моя позиция</span>}
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          className={`community-ranking-games-pill community-ranking-games-pill-button${isDynamics ? ` community-ranking-games-pill--dynamics community-ranking-games-pill--dynamics-${dynamicsTone}` : ""}`}
                          aria-label={`Открыть разбор рейтинга игрока ${row.name}${activeType === "overall" && (row.lastRatingDelta ?? 0) !== 0
                            ? `, последнее изменение рейтинга ${formatSignedNumber(row.lastRatingDelta ?? 0)}`
                            : ""}`}
                          onClick={() => handleOpenRatingBreakdown(row, "score")}
                        >
                          {isDynamics ? (
                            dynamicsTone === "positive" ? (
                              <RankingDeltaArrowIcon direction="up" />
                            ) : dynamicsTone === "negative" ? (
                              <RankingDeltaArrowIcon direction="down" />
                            ) : null
                          ) : (
                            activeType === "overall" ? <RankingOverallIcon /> : <RankingGamesIcon />
                          )}
                          <span className={`community-ranking-games-pill-value${isDynamics ? " community-ranking-games-pill-value--dynamics" : ""}`}>
                            {getRowScoreValue(row, activeType)}
                          </span>
                          {lastRatingTone && lastRatingTone !== "neutral" && (
                            <span
                              className={`community-ranking-last-delta community-ranking-last-delta--${lastRatingTone}`}
                              title={`Последнее изменение рейтинга: ${formatSignedNumber(row.lastRatingDelta ?? 0)}`}
                              aria-hidden="true"
                            >
                              <RankingDeltaArrowIcon direction={lastRatingTone === "positive" ? "up" : "down"} />
                            </span>
                          )}
                        </button>
                      </div>
                      {index < filteredRows.length - 1 && !isCurrentUser && <div className="community-ranking-card-separator" />}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      {isStickyVisible && stickyPosition && currentUserRow && (
        <div
          className={`community-ranking-sticky-shell community-ranking-sticky-shell--${stickyPosition}`}
          style={stickyStyle}
        >
          <div
            className="community-ranking-sticky-button"
            onClick={scrollToCurrentUser}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                scrollToCurrentUser();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Прокрутить к моей позиции в рейтинге"
          >
            <article className="community-ranking-card community-ranking-card--compact is-current community-ranking-card--sticky-copy">
              <div className="community-ranking-card-head">
                <div className="community-ranking-card-player">
                  <div className={`community-ranking-rank-badge${currentUserRow.rank === 1 ? " is-leader" : ""}`}>
                    {currentUserRow.rank === 1 ? <RankingLeaderIcon /> : currentUserRow.rank}
                  </div>

                  <button
                    type="button"
                    className="community-ranking-avatar-button"
                    aria-label={`Открыть разбор рейтинга игрока ${currentUserRow.name}${activeType === "overall" && (currentUserRow.lastRatingDelta ?? 0) !== 0
                      ? `, последнее изменение рейтинга ${formatSignedNumber(currentUserRow.lastRatingDelta ?? 0)}`
                      : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenRatingBreakdown(currentUserRow, "avatar");
                    }}
                  >
                    <div className="community-ranking-avatar community-ranking-avatar--screen">
                      <AvatarImageOrInitials
                        src={currentUserRow.avatar ?? undefined}
                        name={currentUserRow.name}
                        imageClassName="community-ranking-avatar-image"
                      />
                    </div>
                  </button>

                  <div className="community-ranking-card-copy">
                    <div className="community-ranking-name-row">
                      <span className="community-ranking-name">{currentUserRow.name}</span>
                      <span className="community-ranking-you">Моя позиция</span>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className={`community-ranking-games-pill community-ranking-games-pill-button${activeType === "dynamics"
                    ? ` community-ranking-games-pill--dynamics community-ranking-games-pill--dynamics-${getDynamicsTone(currentUserRow.ratingDeltaSum)}`
                    : ""}`}
                  aria-label={`Открыть разбор рейтинга игрока ${currentUserRow.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleOpenRatingBreakdown(currentUserRow, "score");
                  }}
                >
                  {activeType === "dynamics" ? (
                    currentUserRow.ratingDeltaSum > 0 ? (
                      <RankingDeltaArrowIcon direction="up" />
                    ) : currentUserRow.ratingDeltaSum < 0 ? (
                      <RankingDeltaArrowIcon direction="down" />
                    ) : null
                  ) : (
                    activeType === "overall" ? <RankingOverallIcon /> : <RankingGamesIcon />
                  )}
                  <span className={`community-ranking-games-pill-value${activeType === "dynamics" ? " community-ranking-games-pill-value--dynamics" : ""}`}>
                    {getRowScoreValue(currentUserRow, activeType)}
                  </span>
                  {activeType === "overall" && (currentUserRow.lastRatingDelta ?? 0) !== 0 && (
                    <span
                      className={`community-ranking-last-delta community-ranking-last-delta--${getDynamicsTone(currentUserRow.lastRatingDelta ?? 0)}`}
                      title={`Последнее изменение рейтинга: ${formatSignedNumber(currentUserRow.lastRatingDelta ?? 0)}`}
                      aria-hidden="true"
                    >
                      <RankingDeltaArrowIcon direction={(currentUserRow.lastRatingDelta ?? 0) > 0 ? "up" : "down"} />
                    </span>
                  )}
                </button>
              </div>
            </article>
          </div>
        </div>
      )}

      <CommunityBottomNav
        activeItem="table"
        chatBadgeCount={chatBadgeCount}
        onSelect={onSelectBottomNav}
        actionSlot={navActionSlot}
      />
    </div>
  );
}

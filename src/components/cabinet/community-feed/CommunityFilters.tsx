import type { CommunityFeedFilterId } from "./feedTypes";

interface CommunityFiltersProps {
  activeFilter: CommunityFeedFilterId;
  onChange: (filterId: CommunityFeedFilterId) => void;
}

const FILTER_ITEMS: Array<{ id: CommunityFeedFilterId; label: string }> = [
  { id: "all", label: "Все" },
  { id: "games", label: "Игры" },
  { id: "tournaments", label: "Турниры" },
  { id: "news", label: "Новости" },
];

export function CommunityFilters({ activeFilter, onChange }: CommunityFiltersProps) {
  return (
    <div className="community-filters" role="tablist" aria-label="Фильтры ленты сообщества">
      {FILTER_ITEMS.map((filterItem) => {
        const isActive = filterItem.id === activeFilter;

        return (
          <button
            key={filterItem.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`community-filter-pill community-filter-pill--${filterItem.id}${isActive ? " is-active" : ""}`}
            onClick={() => onChange(filterItem.id)}
          >
            <span className="community-filter-pill-label">{filterItem.label}</span>
          </button>
        );
      })}
    </div>
  );
}

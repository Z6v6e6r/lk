import type { CommunityBottomNavItemId } from "./feedTypes";

export type CommunitySecondaryNavItemId = Extract<CommunityBottomNavItemId, "feed" | "chat" | "ranking">;

const SECONDARY_NAV_ITEMS: Array<{ id: CommunitySecondaryNavItemId; label: string }> = [
  { id: "feed", label: "Лента" },
  { id: "chat", label: "Чат" },
  { id: "ranking", label: "Рейтинг" },
];

interface CommunitySecondaryNavProps {
  activeItem: CommunitySecondaryNavItemId;
  onSelect: (itemId: CommunitySecondaryNavItemId) => void;
}

export function CommunitySecondaryNav({
  activeItem,
  onSelect,
}: CommunitySecondaryNavProps) {
  return (
    <div className="community-secondary-nav" role="tablist" aria-label="Разделы сообщества">
      {SECONDARY_NAV_ITEMS.map((item) => {
        const isActive = item.id === activeItem;

        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`community-secondary-nav-tab community-secondary-nav-tab--${item.id}${isActive ? " is-active" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

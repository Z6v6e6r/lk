import type { ReactNode } from "react";
import {
  BubbleNavIcon,
  HomeNavIcon,
  MoonNavIcon,
  ProfileNavIcon,
} from "./CommunityIcons";
import type { CommunityBottomNavItemId } from "./feedTypes";

interface CommunityBottomNavProps {
  activeItem: CommunityBottomNavItemId;
  chatBadgeCount: number;
  onSelect: (itemId: CommunityBottomNavItemId) => void;
  actionSlot?: ReactNode;
  layout?: "fixed" | "static";
}

const NAV_ITEMS: Array<{ id: CommunityBottomNavItemId; label: string }> = [
  { id: "feed", label: "Лента" },
  { id: "table", label: "Таблица" },
  { id: "chat", label: "Чат" },
  { id: "ranking", label: "Рейтинг" },
];

export function CommunityBottomNav({
  activeItem,
  chatBadgeCount,
  onSelect,
  actionSlot,
  layout = "fixed",
}: CommunityBottomNavProps) {
  const leftItems = actionSlot ? NAV_ITEMS.slice(0, 2) : NAV_ITEMS;
  const rightItems = actionSlot ? NAV_ITEMS.slice(2) : [];

  const renderNavItem = (item: { id: CommunityBottomNavItemId; label: string }) => {
    const isActive = item.id === activeItem;

    return (
      <button
        key={item.id}
        type="button"
        className={`community-bottom-nav-item community-bottom-nav-item--${item.id}${isActive ? " is-active" : ""}`}
        onClick={() => onSelect(item.id)}
        aria-current={isActive ? "page" : undefined}
        aria-label={item.label}
      >
        <span className="community-bottom-nav-item-inner">
          <span className="community-bottom-nav-icon-wrap">
            {item.id === "feed" && <HomeNavIcon className="community-bottom-nav-icon" />}
            {item.id === "table" && <MoonNavIcon className="community-bottom-nav-icon" />}
            {item.id === "chat" && <BubbleNavIcon className="community-bottom-nav-icon" />}
            {item.id === "ranking" && <ProfileNavIcon className="community-bottom-nav-icon" />}
            {item.id === "chat" && chatBadgeCount > 0 && (
              <span className="community-bottom-nav-badge">{chatBadgeCount}</span>
            )}
          </span>
          <span className="community-visually-hidden">{item.label}</span>
        </span>
      </button>
    );
  };

  return (
    <nav
      className={`community-bottom-nav${actionSlot ? " community-bottom-nav--with-action" : ""}${layout === "static" ? " community-bottom-nav--static" : ""}`}
      aria-label="Навигация сообщества"
    >
      {leftItems.map(renderNavItem)}

      {actionSlot ? (
        <div className="community-bottom-nav-action-slot">
          {actionSlot}
        </div>
      ) : null}

      {rightItems.map(renderNavItem)}
    </nav>
  );
}

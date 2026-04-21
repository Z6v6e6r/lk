import { useEffect, useRef, useState } from "react";
import { CalendarPlusIcon, InviteIcon, PlusIcon } from "./CommunityIcons";

interface CommunityFabProps {
  onAddPost: () => void;
  onScheduleGame: () => void;
  onInvitePlayers: () => void;
  variant?: "floating" | "nav";
}

export function CommunityFab({
  onAddPost,
  onScheduleGame,
  onInvitePlayers,
  variant = "floating",
}: CommunityFabProps) {
  const [isOpen, setIsOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const nextTarget = event.target;
      if (!(nextTarget instanceof Node)) return;
      if (shellRef.current?.contains(nextTarget)) return;
      setIsOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  const runAction = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  const isNavVariant = variant === "nav";

  return (
    <div
      ref={shellRef}
      className={`community-feed-fab-shell${isOpen ? " is-open" : ""}${isNavVariant ? " community-feed-fab-shell--nav" : ""}`}
    >
      {isOpen && (
        <div
          className={`community-feed-fab-menu${isNavVariant ? " community-feed-fab-menu--nav" : ""}`}
          role="menu"
          aria-label="Быстрые действия сообщества"
        >
          <button
            type="button"
            className="community-feed-fab-menu-action"
            onClick={() => runAction(onAddPost)}
            role="menuitem"
          >
            <span className="community-feed-fab-menu-action-main">
              <PlusIcon className="community-feed-fab-menu-action-icon" />
              <span>Добавить запись</span>
            </span>
          </button>

          <button
            type="button"
            className="community-feed-fab-menu-action"
            onClick={() => runAction(onScheduleGame)}
            role="menuitem"
          >
            <span className="community-feed-fab-menu-action-main">
              <CalendarPlusIcon className="community-feed-fab-menu-action-icon" />
              <span>Запланировать игру</span>
            </span>
          </button>

          <button
            type="button"
            className="community-feed-fab-menu-action"
            onClick={() => runAction(onInvitePlayers)}
            role="menuitem"
          >
            <span className="community-feed-fab-menu-action-main">
              <InviteIcon className="community-feed-fab-menu-action-icon" />
              <span>Пригласить игроков</span>
            </span>
          </button>
        </div>
      )}

      <button
        type="button"
        className={`community-feed-fab${isNavVariant ? " community-feed-fab--nav" : ""}`}
        onClick={() => setIsOpen((current) => !current)}
        aria-label="Открыть быстрые действия"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <PlusIcon className="community-feed-fab-icon" />
      </button>
    </div>
  );
}

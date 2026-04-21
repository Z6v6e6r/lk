import { CalendarPlusIcon, ChevronRightIcon, InviteIcon, PlusIcon } from "./CommunityIcons";

interface CommunityTopActionsProps {
  canCreate: boolean;
  onAddPost: () => void;
  onScheduleGame: () => void;
  onInvitePlayers: () => void;
}

export function CommunityTopActions({
  canCreate,
  onAddPost,
  onScheduleGame,
  onInvitePlayers,
}: CommunityTopActionsProps) {
  return (
    <div className="community-top-actions">
      <div className="community-top-actions-row">
        <button
          type="button"
          className="community-top-action community-top-action--primary"
          onClick={onAddPost}
          disabled={!canCreate}
        >
          <PlusIcon className="community-top-action-inline-icon" />
          <span className="community-top-action-title community-top-action-title--primary">Добавить запись</span>
        </button>

        <button
          type="button"
          className="community-top-action community-top-action--card"
          onClick={onScheduleGame}
          disabled={!canCreate}
        >
          <span className="community-top-action-leading">
            <CalendarPlusIcon className="community-top-action-leading-icon" />
            <span className="community-top-action-title community-top-action-title--multiline">Запланировать игру</span>
          </span>
          <ChevronRightIcon className="community-top-action-trailing-icon" />
        </button>
      </div>

      <button
        type="button"
        className="community-top-action community-top-action--secondary"
        onClick={onInvitePlayers}
      >
        <span className="community-top-action-leading">
          <InviteIcon className="community-top-action-leading-icon" />
          <span className="community-top-action-title">Пригласить игроков</span>
        </span>
        <ChevronRightIcon className="community-top-action-trailing-icon" />
      </button>
    </div>
  );
}

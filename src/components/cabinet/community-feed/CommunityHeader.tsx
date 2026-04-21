import type { CommunityRecord } from "../../../utils/communityApi";
import { MembersCountIcon } from "./CommunityIcons";
import { getInitials } from "./feedFormatters";

interface CommunityHeaderProps {
  community: Pick<CommunityRecord, "name" | "logo"> & { memberCount?: number | null };
  onOpenMenu: () => void;
  onClose: () => void;
}

function formatMemberCount(value: number) {
  const mod10 = value % 10;
  const mod100 = value % 100;

  if (mod10 === 1 && mod100 !== 11) return `${value} участник`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${value} участника`;
  return `${value} участников`;
}

function getMemberCountParts(value: number) {
  const formatted = formatMemberCount(value);
  const separatorIndex = formatted.indexOf(" ");

  if (separatorIndex === -1) {
    return { count: formatted, label: "" };
  }

  return {
    count: formatted.slice(0, separatorIndex),
    label: formatted.slice(separatorIndex + 1),
  };
}

function HeaderBackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="community-header-circle-icon" aria-hidden="true">
      <path d="M14.75 6.5 9.25 12l5.5 5.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HeaderMoreIcon() {
  return (
    <svg viewBox="0 0 24 24" className="community-header-circle-icon" aria-hidden="true">
      <circle cx="6" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function CommunityHeader({ community, onOpenMenu, onClose }: CommunityHeaderProps) {
  const memberCountParts = typeof community.memberCount === "number"
    ? getMemberCountParts(community.memberCount)
    : null;

  return (
    <header className="community-header">
      <div className="community-header-bar">
        <button
          type="button"
          className="community-header-circle-button"
          onClick={onClose}
          aria-label="Назад"
        >
          <HeaderBackIcon />
        </button>

        <div className="community-header-summary">
          <div className="community-header-avatar">
            {community.logo ? (
              <img src={community.logo} alt={community.name} className="community-header-avatar-image" />
            ) : (
              <span className="community-header-avatar-fallback">{getInitials(community.name)}</span>
            )}
          </div>

          <div className="community-header-copy">
            <h2 className="community-header-title">{community.name}</h2>
            {memberCountParts ? (
              <div className="community-header-member-row">
                <span className="community-header-member-count">{memberCountParts.count}</span>
                <MembersCountIcon className="community-header-member-icon" />
                <span className="community-header-member-label">{memberCountParts.label}</span>
              </div>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          className="community-header-circle-button"
          onClick={onOpenMenu}
          aria-label="Открыть меню сообщества"
        >
          <HeaderMoreIcon />
        </button>
      </div>
    </header>
  );
}

import type { ReactNode } from "react";
import type { CommunityMember, CommunityRecord } from "../../../utils/communityApi";
import { formatScoreDisplay } from "../../../utils/customFields";
import { isViewerIdentity } from "../../../utils/viewerIdentity";
import { CommunityBottomNav } from "./CommunityBottomNav";
import { CommunityHeader } from "./CommunityHeader";
import { AvatarImageOrInitials } from "./AvatarImageOrInitials";
import type { CommunityBottomNavItemId } from "./feedTypes";

interface CommunityTableScreenProps {
  community: Pick<CommunityRecord, "name" | "logo" | "isVerified">;
  members: CommunityMember[];
  currentUserId: string | null;
  currentUserPhone: string | null;
  chatBadgeCount: number;
  onOpenMenu: () => void;
  onClose: () => void;
  onSelectBottomNav: (itemId: CommunityBottomNavItemId) => void;
  navActionSlot?: ReactNode;
}

function getCommunityRoleLabel(role: CommunityMember["role"]) {
  if (role === "OWNER") return "владелец";
  if (role === "ADMIN") return "админ";
  if (role === "MODERATOR") return "модератор";
  return "участник";
}

export function CommunityTableScreen({
  community,
  members,
  currentUserId,
  currentUserPhone,
  chatBadgeCount,
  onOpenMenu,
  onClose,
  onSelectBottomNav,
  navActionSlot,
}: CommunityTableScreenProps) {
  return (
    <div className="community-feed-screen community-table-screen">
      <div className="community-feed-screen-glow" aria-hidden="true" />

      <CommunityHeader community={community} onOpenMenu={onOpenMenu} onClose={onClose} />

      <section className="community-detail-section">
        <div className="community-detail-section-head">
          <h3 className="community-detail-section-title">Таблица участников</h3>
          <span className="community-detail-section-caption">Список игроков сообщества</span>
        </div>

        <div className="community-settings-members-head">
          <div>
            <h4 className="community-detail-section-title">Участники</h4>
            <div className="community-detail-section-caption">Актуальный список игроков внутри сообщества.</div>
          </div>
          <span className="community-members-count">{members.length}</span>
        </div>

        {members.length === 0 ? (
          <div className="community-empty-note">В сообществе пока нет участников.</div>
        ) : (
          <div className="community-members-list">
            {members.map((member) => {
              const memberKey = member.id ?? member.phone ?? member.name;
              const isCurrentUser = isViewerIdentity(member, { id: currentUserId, phone: currentUserPhone });

              return (
                <div key={`table-member-${memberKey}`} className="community-member-row">
                  <div className="community-member-main">
                    <div className="community-member-avatar">
                      <AvatarImageOrInitials src={member.avatar ?? undefined} name={member.name} imageClassName="community-ranking-avatar-image" />
                    </div>
                    <div className="community-member-copy">
                      <div className="community-member-name-row">
                        <span className="community-member-name">{member.name}</span>
                        {isCurrentUser ? <span className="community-ranking-you">Вы</span> : null}
                      </div>
                      <div className="community-member-meta">
                        {member.levelLabel} • {formatScoreDisplay(member.levelScore)} • {getCommunityRoleLabel(member.role)}
                      </div>
                    </div>
                  </div>

                  <div className="community-member-role-tag">{member.role === "OWNER" ? "OWNER" : member.role}</div>
                </div>
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

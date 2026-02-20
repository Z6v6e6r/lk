import { useAuth } from "../../context/AuthContext";
import type { UserProfileType } from "../../utils/apiClient";

interface UserProfileProps {
  profile: UserProfileType;
  openEditForm: () => void;
}

export function UserProfile({ profile, openEditForm }: UserProfileProps) {
  const { logout } = useAuth();
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ");
  const initials = (profile.firstName?.[0] || "") + (profile.lastName?.[0] || "");
  const balance = (profile.deposit / 100).toLocaleString("ru-RU");
  const points = profile.customFields?.[4]?.value?.[0];

  return (
    <div className="cab-header">
      <div className="cab-user-row">
      {profile.photo ? (
  <div className="cab-avatar-wrapper">
    <svg className="cab-avatar-ring" viewBox="0 0 60 60">
      <circle cx="30" cy="30" r="27" fill="none" stroke="#e5e7eb" strokeWidth="4"/>
      {Array.from({length: 135}, (_, idx) => {
        const i = idx + 1;
        const t = i / 135;
        const power = Math.pow(t, 3);
        const segmentLength = 127 / 135;
        const start = idx * segmentLength;
        const r = Math.round(180 + power * (53 - 180));
        const g = Math.round(150 + power * (63 - 150));
        const b = Math.round(255 + power * (185 - 255));
        return (
          <circle key={i}
            cx="30" cy="30" r="27"
            fill="none"
            stroke={`rgb(${r},${g},${b})`}
            strokeWidth={0.3 + power * 10}
            strokeDasharray={`${segmentLength} 169`}
            strokeDashoffset={-start}
            strokeLinecap="butt"
            transform="rotate(90 30 30)"
          />
        );
      })}
    </svg>
    <img src={profile.photo} alt="Аватар" className="cab-avatar" />
    <div className="cab-avatar-badge">{points || "B+"}</div>
  </div>
) : (
  <div className="cab-avatar-placeholder">{initials || "?"}</div>
)}
        <div className="cab-user-info">
          <div className="cab-user-name">{fullName || "Профиль"}</div>
          <div className="cab-user-phone">+{profile.phone}</div>
        </div>
        <div className="cab-header-actions">
  <button className="cab-icon-btn" onClick={openEditForm} title="Редактировать">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 21h3.75L17.81 9.94l-3.75-3.75L3 17.25V21zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#1A1A1A"/>
    </svg>
  </button>
  <button className="cab-icon-btn" onClick={logout} title="Выйти">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5-5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" fill="#1A1A1A"/>
    </svg>
  </button>
</div>
      </div>

      <div className="balance-row">
        <div>
          <div className="balance-label">Баланс</div>
          <div className="balance-amount">{balance} ₽</div>
        </div>
        {/*{points && (
          <span className="balance-badge">⭐ {points}</span>
        )}*/}
      </div>
    </div>
  );
}

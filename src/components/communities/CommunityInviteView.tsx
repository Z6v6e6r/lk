import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import logo from "../../assets/logo-hab-compact.svg";
import { buildCommunityLogoCandidates, type CommunityRecord } from "../../utils/communityApi";
import "./community-invite.css";

export type CommunityInviteState = "checking" | "guest" | "invited" | "unverified" | "member" | "pending" | "blocked" | "error";

/** Presentation-only branding for a public invitation that has no authenticated community read yet. */
export interface CommunityInviteBrand {
  readonly heading: string;
  readonly note?: string;
  readonly logoUrl?: string | null;
}

export function formatCommunityParticipants(value: number | undefined) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "";
  const mod100 = value % 100, mod10 = value % 10;
  const word = mod100 >= 11 && mod100 <= 14 ? "участников" : mod10 === 1 ? "участник" : mod10 >= 2 && mod10 <= 4 ? "участника" : "участников";
  return `${value.toLocaleString("ru-RU")} ${word}`;
}

function brandInitials(heading: string): string {
  const words = heading.split(/\s+/).filter(Boolean);
  const camel = words.find(word => Array.from(word).slice(1).some(char => /[A-ZА-ЯЁ]/.test(char)));
  const letters = Array.from(camel ?? words.find(word => /[A-Za-zА-Яа-яЁё]/.test(word)) ?? heading)
    .filter(char => /[A-ZА-ЯЁ]/.test(char));
  return (letters.slice(0, 2).join("") || Array.from(heading)[0] || "?").toUpperCase();
}

export function CommunityInviteView({ state, community, busy = false, busyLabel, error, reason, brand, preflight = false, onPrimary, onSecondary, children }: {
  state: CommunityInviteState;
  community?: CommunityRecord | null;
  busy?: boolean;
  busyLabel?: string;
  error?: string | null;
  reason?: string | null;
  brand?: CommunityInviteBrand;
  preflight?: boolean;
  onPrimary?: () => void;
  onSecondary?: () => void;
  children?: ReactNode;
}) {
  const titleId = useId(), errorId = useId();
  const candidates = useMemo(() => buildCommunityLogoCandidates(community), [community]);
  const [imageIndex, setImageIndex] = useState(0);
  const [heroLogoFailed, setHeroLogoFailed] = useState(false);
  useEffect(() => setImageIndex(0), [candidates]);
  useEffect(() => setHeroLogoFailed(false), [brand?.logoUrl]);
  const name = community?.name || "Приглашение в сообщество";
  const initials = name.split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join("").toUpperCase();
  const location = [community?.city, community ? community.visibility === "OPEN" ? "Открытое сообщество" : "Закрытое сообщество" : ""].filter(Boolean).join(" · ");
  const labels = { checking: "Проверяем…", guest: "Войти и продолжить", invited: "Вступить в сообщество", unverified: "Вступить в сообщество", member: "Открыть сообщество", pending: "Проверить статус", blocked: "Вступление недоступно", error: "Проверить статус" };
  const status = preflight
    ? "Загружаем анкету…"
    : state === "checking" ? "Проверяем приглашение…"
    : state === "unverified" ? (brand ? "" : "Условия вступления проверит сервер.")
    : state === "member" ? "Вы уже в сообществе"
    : state === "pending" ? "Заявка отправлена. Ожидаем подтверждения."
    : state === "blocked" ? reason || "Приглашение недоступно."
    : "";
  const participants = formatCommunityParticipants(community?.memberCount);
  const heroLogo = brand?.logoUrl && !heroLogoFailed ? brand.logoUrl : null;
  return <section className="ph-community-invite" lang="ru" aria-labelledby={titleId} aria-busy={busy || state === "checking"}>
    <header className="ph-community-invite__header"><img className="ph-community-invite__logo" src={logo} alt="ПадлхАБ" /><span className="ph-community-invite__header-label">Сообщества</span></header>
    <div className="ph-community-invite__main">
      {brand ? <div className="ph-community-invite__hero">
        {heroLogo
          ? <img className="ph-community-invite__hero-logo" src={heroLogo} alt={name} onError={() => setHeroLogoFailed(true)} />
          : <span className="ph-community-invite__hero-badge" aria-hidden="true">{brandInitials(brand.heading)}</span>}
        <h1 className="ph-community-invite__hero-title" id={titleId}>{brand.heading}</h1>
        {brand.note && <p className="ph-community-invite__hero-note">{brand.note}</p>}
      </div> : <>
        <p className="ph-community-invite__eyebrow">{state === "member" ? "Сообщество" : "Приглашение в сообщество"}</p>
        <div className="ph-community-invite__identity">
          <div className="ph-community-invite__avatar-wrap">{candidates[imageIndex] ? <img className="ph-community-invite__avatar" src={candidates[imageIndex]} alt={name} onError={() => setImageIndex(index => index + 1)} /> : <span className="ph-community-invite__avatar-fallback" aria-hidden="true">{initials}</span>}</div>
          <div><h1 className="ph-community-invite__name" id={titleId}>{name}</h1>{location && <p className="ph-community-invite__location">{location}</p>}</div>
        </div>
        {community?.description && <p className="ph-community-invite__description">{community.description}</p>}
        {(participants || community?.minimumLevel) && <ul className="ph-community-invite__facts" aria-label="Сведения о сообществе">{participants && <li>{participants}</li>}{community?.minimumLevel && <li>Уровень от {community.minimumLevel}</li>}</ul>}
      </>}
      <div className="ph-community-invite__actions">
        {status && <p className="ph-community-invite__status" role="status">{state === "member" && !preflight && <span className="ph-community-invite__status-mark" aria-hidden="true">✓</span>}{status}</p>}
        {error && <p className="ph-community-invite__error" role="alert" id={errorId}>{error}</p>}
        {!children && !preflight && <button className="ph-community-invite__primary" type="button" disabled={busy || state === "checking" || state === "blocked" || !onPrimary} aria-describedby={error ? errorId : undefined} onClick={onPrimary}>{busy ? busyLabel || "Проверяем…" : labels[state]}{state === "member" && !busy && <span aria-hidden="true">→</span>}</button>}
        {children}
        {onSecondary && !preflight && state !== "checking" && state !== "error" && <button className="ph-community-invite__secondary" type="button" disabled={busy} onClick={onSecondary}>{state === "guest" || state === "invited" || state === "unverified" ? "Не сейчас" : "В личный кабинет"}</button>}
      </div>
    </div>
  </section>;
}

import './event-community.css';
import type { CommunityRecord } from '../../utils/communityApi';
import { EXHIBITION_COMMUNITY_ID, EXHIBITION_GAME_URL, EXHIBITION_LIVE_URL, buildPushOptInUrl, exhibitionCommunityUrl, readExhibitionPushOptIn } from '../padel-jump/exhibition';

/** Only the isolated exhibition; no generic game engine enters the cabinet bundle. */
export function EventCommunityPanel({ community, isMember = false, onRegister }: { community: CommunityRecord; isMember?: boolean; onRegister: () => void }) {
  if (community.id !== EXHIBITION_COMMUNITY_ID) return null;
  if (isMember) {
    if (readExhibitionPushOptIn() !== false) return null;
    return <section className="community-ranking-box community-event-panel community-event-push-prompt" aria-label="Уведомления о результатах">
      <h2>Уведомления о результатах</h2>
      <p>Включите уведомления — пришлём результаты соревнований в сообществе {community.name}.</p>
      <a className="btn-secondary" href={buildPushOptInUrl(exhibitionCommunityUrl(community.id))}>Подключить уведомления</a>
    </section>;
  }
  return <section className="community-ranking-box community-event-panel" aria-label="Игры и рейтинг мероприятия">
    <h2>ПадлхАБ Jump — 5 жизней</h2>
    <p>Вступить в сообщество можно в любое время. ФИО, компания и email из обязательной анкеты не публикуются в рейтинге.</p>
    <button type="button" className="btn-secondary" onClick={onRegister}>Заполнить анкету</button>
    <a className="btn-primary" href={EXHIBITION_GAME_URL}>Играть в Jump</a>
    <a className="btn-secondary" href={EXHIBITION_LIVE_URL} target="_blank" rel="noopener noreferrer">Общий экран ↗</a>
    <p>Игра открыта 12–13 ноября 2026 года (МСК). Результаты — во вкладке «Рейтинг»: больше звёзд — выше место; при равенстве сравнивается время.</p>
  </section>;
}

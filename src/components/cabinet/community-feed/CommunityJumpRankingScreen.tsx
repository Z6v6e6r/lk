import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CommunityRecord } from '../../../utils/communityApi';
import { AvatarImageOrInitials } from './AvatarImageOrInitials';
import { CommunityHeader } from './CommunityHeader';
import { CommunitySecondaryNav, type CommunitySecondaryNavItemId } from './CommunitySecondaryNav';
import { CommunityBottomNav } from './CommunityBottomNav';
import type { CommunityBottomNavItemId } from './feedTypes';
import { fetchCommunityJumpRanking, formatJumpRankingTime, JUMP_GAME_URL, type CommunityJumpRanking, type CommunityJumpRankingRow } from './communityJumpRanking';
import './community-jump-ranking.css';

type Props = {
  community: Pick<CommunityRecord, 'id' | 'name' | 'logo' | 'memberCount'>;
  profileKey: string; currentUserAvatar?: string | null; chatBadgeCount: number;
  onOpenMenu: () => void; onClose: () => void;
  onSelectSectionNav: (id: CommunitySecondaryNavItemId) => void;
  onSelectBottomNav: (id: CommunityBottomNavItemId) => void;
  navActionSlot?: ReactNode;
};

export function CommunityJumpRankingResults({ data, currentUserAvatar, search = '' }: { data: CommunityJumpRanking; currentUserAvatar?: string | null; search?: string }) {
  const query = search.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const matches = (row: CommunityJumpRankingRow) => row.name.toLocaleLowerCase('ru').replace(/ё/g, 'е').includes(query);
  const rows = data.rows.filter(matches), ownOutside = data.me && !data.rows.some(row => row.id === data.me!.id) && matches(data.me) ? data.me : null;
  const card = (row: CommunityJumpRankingRow) => {
    const isCurrentUser = row.isCurrentUser && row.id === data.me?.id;
    return <li key={row.id} value={row.rank} className={`community-jump-row${isCurrentUser ? ' is-current' : ''}`} aria-label={`Место ${row.rank}: ${row.name}, ${row.stars} звёзд, ${formatJumpRankingTime(row.elapsedMs)}`}>
      <span className="community-jump-place" aria-label={`Место ${row.rank}`}>{row.rank}</span>
      <div className="community-jump-avatar"><AvatarImageOrInitials src={isCurrentUser ? currentUserAvatar ?? undefined : undefined} name={row.name} imageClassName="community-jump-avatar-image" /></div>
      <div className="community-jump-person"><strong>{row.name}</strong>{isCurrentUser && <span className="community-jump-self">Вы</span>}</div>
      <div className="community-jump-score"><strong aria-label={`Звёзды: ${row.stars}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" /></svg>{row.stars}</strong><time>{formatJumpRankingTime(row.elapsedMs)}</time></div>
    </li>;
  };
  return <>
    {!data.total ? <p className="community-jump-note">Заездов пока нет. Первый результат появится после пяти потерь жизни или финиша маршрута.</p>
      : !rows.length && !ownOutside ? <p className="community-jump-note">Игрок по запросу не найден.</p>
        : <>{rows.length > 0 && <ol className="community-jump-list" aria-label="Результаты игроков">{rows.map(card)}</ol>}{ownOutside && <><p className="community-jump-note">Ваша позиция</p><ol className="community-jump-list" aria-label="Ваша позиция в рейтинге">{card(ownOutside)}</ol></>}</>}
    {!data.me && data.total > 0 && <p className="community-jump-note">У тебя ещё нет завершённого заезда.</p>}
  </>;
}

export function CommunityJumpRankingScreen({ community, profileKey, currentUserAvatar, chatBadgeCount, onOpenMenu, onClose, onSelectSectionNav, onSelectBottomNav, navActionSlot }: Props) {
  const [data, setData] = useState<CommunityJumpRanking | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true, busy = false; let controller: AbortController | undefined;
    let nextPollAt = 0;
    setData(null); setError(''); setSearch('');
    const load = async () => {
      if (document.hidden || busy) return;
      busy = true; controller = new AbortController(); setLoading(true);
      try { const next = await fetchCommunityJumpRanking(community.id, controller.signal); if (active) { setData(next); setError(''); nextPollAt = Date.now() + 30000; } }
      catch (reason) {
        if (!active || controller.signal.aborted) return;
        if (reason && typeof reason === 'object' && 'status' in reason && [401, 403].includes(Number(reason.status))) setData(null);
        setError(reason instanceof Error ? reason.message : 'Не удалось загрузить рейтинг Jump.');
        nextPollAt = Date.now() + 60000;
      } finally { busy = false; if (active) setLoading(false); }
    };
    const refresh = () => { if (Date.now() >= nextPollAt) void load(); };
    refreshRef.current = () => { void load(); };
    const interval = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh); refresh();
    return () => { active = false; controller?.abort(); clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); refreshRef.current = () => {}; };
  }, [community.id, profileKey]);
  const canHideSearch = !loading && !error && data !== null
    && Number.isSafeInteger(data.total) && data.total >= 0 && data.total <= 2
    && data.rows.length === data.total && search.trim() === '';
  return <div className="community-feed-screen community-jump-ranking-screen">
    <CommunityHeader community={community} onOpenMenu={onOpenMenu} onClose={onClose} />
    <CommunitySecondaryNav activeItem="ranking" onSelect={onSelectSectionNav} />
    <section className="community-jump-box" aria-label="Рейтинг ПадлхАБ Jump" aria-busy={loading}>
      <div className="community-jump-title"><h3>ПадлхАБ Jump</h3><p>Больше звёзд — выше место.</p></div>
      <details className="community-jump-rules"><summary>Как считается рейтинг</summary><p>Сначала сравниваем количество звёзд. При равенстве выше игрок с меньшим временем.</p></details>
      {!canHideSearch && <label className="community-jump-search"><span className="community-visually-hidden">Поиск игрока</span><input type="search" placeholder="Поиск игрока" aria-label="Поиск игрока" value={search} onChange={event => setSearch(event.target.value)} /></label>}
      {error && <p role="alert" className="community-jump-error">{error}{data ? ' Показаны последние полученные данные.' : ''}</p>}
      {loading && <p role="status" className="community-jump-note">{data ? 'Обновляем результат…' : 'Загружаем рейтинг Jump…'}</p>}
      {data && data.total > 0 && <div className="community-jump-columns" aria-hidden="true"><span>Игроки</span><span>Звёзды · время</span></div>}
      {data && <CommunityJumpRankingResults data={data} currentUserAvatar={currentUserAvatar} search={search} />}
      <a className="community-jump-play" href={JUMP_GAME_URL} target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="m8 4 12 8-12 8Z" /></svg>Играть</a>
      <button type="button" className="community-jump-refresh" disabled={loading} onClick={() => refreshRef.current()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></svg>Обновить рейтинг</button>
    </section>
    <CommunityBottomNav activeItem="ranking" chatBadgeCount={chatBadgeCount} onSelect={onSelectBottomNav} actionSlot={navActionSlot} />
  </div>;
}

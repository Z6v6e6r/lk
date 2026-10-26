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
  const card = (row: CommunityJumpRankingRow) => <article key={row.id} className={`community-jump-row${row.isCurrentUser ? ' is-current' : ''}`} aria-label={`Место ${row.rank}: ${row.name}, ${row.stars} звёзд, ${formatJumpRankingTime(row.elapsedMs)}`}>
    <span className="community-jump-place" aria-label={`Место ${row.rank}`}>{row.rank === 1 ? '♛' : row.rank}</span>
    <div className="community-jump-avatar"><AvatarImageOrInitials src={row.isCurrentUser ? currentUserAvatar ?? undefined : undefined} name={row.name} imageClassName="community-jump-avatar-image" /></div>
    <div className="community-jump-person"><strong>{row.name}</strong>{row.isCurrentUser && <span className="community-jump-self">Моя позиция</span>}</div>
    <div className="community-jump-score"><strong>★ {row.stars}</strong><time>{formatJumpRankingTime(row.elapsedMs)}</time></div>
  </article>;
  return <>
    {!data.total ? <p className="community-jump-note">Заездов пока нет. Первый результат появится после пяти потерь жизни или финиша маршрута.</p>
      : !rows.length && !ownOutside ? <p className="community-jump-note">Игрок по запросу не найден.</p>
        : <div className="community-jump-list">{rows.map(card)}{ownOutside && <><p className="community-jump-note">Моя позиция</p>{card(ownOutside)}</>}</div>}
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
  return <div className="community-feed-screen community-jump-ranking-screen">
    <CommunityHeader community={community} onOpenMenu={onOpenMenu} onClose={onClose} />
    <CommunitySecondaryNav activeItem="ranking" onSelect={onSelectSectionNav} />
    <section className="community-jump-box" aria-label="Рейтинг Jump" aria-busy={loading}>
      <div className="community-jump-title"><div><h3>Рейтинг Jump</h3><p>Больше звёзд — выше. При равенстве — меньшее время.</p></div><a href={JUMP_GAME_URL} target="_blank" rel="noopener noreferrer">Играть ↗</a></div>
      <p className="community-jump-note">Лучший заезд каждого участника · {data?.lives ?? 5} жизней{data ? ` · последние ${data.retentionHours} ч.` : ''}</p>
      <label className="community-jump-search"><span className="community-visually-hidden">Поиск игрока</span><input type="search" placeholder="Поиск игрока" aria-label="Поиск игрока" value={search} onChange={event => setSearch(event.target.value)} /></label>
      {error && <p role="alert" className="community-jump-error">{error}{data ? ' Показаны последние полученные данные.' : ''}</p>}
      {loading && <p role="status" className="community-jump-note">{data ? 'Обновляем результат…' : 'Загружаем рейтинг Jump…'}</p>}
      {data && <CommunityJumpRankingResults data={data} currentUserAvatar={currentUserAvatar} search={search} />}
      <button type="button" className="community-jump-refresh" disabled={loading} onClick={() => refreshRef.current()}>Обновить</button>
    </section>
    <CommunityBottomNav activeItem="ranking" chatBadgeCount={chatBadgeCount} onSelect={onSelectBottomNav} actionSlot={navActionSlot} />
  </div>;
}

import { FeedCardGame } from "./FeedCardGame";
import { FeedCardNews } from "./FeedCardNews";
import { FeedCardTournament } from "./FeedCardTournament";
import { FeedCardUserJoined } from "./FeedCardUserJoined";
import type { FeedEntry, Game, News, Tournament, User, UserJoined } from "./feedTypes";

interface FeedListProps {
  entries: FeedEntry[];
  onOpenGame: (game: Game, entry: FeedEntry) => void;
  onOpenTournament: (tournament: Tournament, entry: FeedEntry) => void;
  onOpenNews: (news: News, entry: FeedEntry) => void;
  onAddFriend: (user: User, entry: FeedEntry) => void;
  onMessageUser: (user: User, entry: FeedEntry) => void;
}

export function FeedList({
  entries,
  onOpenGame,
  onOpenTournament,
  onOpenNews,
  onAddFriend,
  onMessageUser,
}: FeedListProps) {
  return (
    <div className="community-feed-list">
      {entries.map((entry) => {
        const item = entry.item;

        if (item.type === "game") {
          const game = item.data;
          return (
            <FeedCardGame
              key={entry.id}
              game={game}
              author={entry.author}
              publishedAt={entry.publishedAt}
              onOpen={() => onOpenGame(game, entry)}
            />
          );
        }

        if (item.type === "tournament") {
          const tournament = item.data;
          return (
            <FeedCardTournament
              key={entry.id}
              tournament={tournament}
              onOpen={() => onOpenTournament(tournament, entry)}
            />
          );
        }

        if (item.type === "news") {
          const news = item.data;
          return (
            <FeedCardNews
              key={entry.id}
              news={news}
              onOpen={() => onOpenNews(news, entry)}
            />
          );
        }

        const joinedItem: UserJoined = item.data;
        return (
          <FeedCardUserJoined
            key={entry.id}
            item={joinedItem}
            onAddFriend={() => onAddFriend(joinedItem.user, entry)}
            onMessage={() => onMessageUser(joinedItem.user, entry)}
          />
        );
      })}
    </div>
  );
}

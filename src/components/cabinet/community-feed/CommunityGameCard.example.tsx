import { CommunityGameCard } from "./CommunityGameCard";
import { communityGameCardMock } from "./CommunityGameCard.mock";
import styles from "./CommunityGameCard.module.css";

export function CommunityGameCard390Example() {
  return (
    <div className={styles.preview390}>
      <CommunityGameCard {...communityGameCardMock} />
    </div>
  );
}

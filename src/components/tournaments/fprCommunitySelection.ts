import type { TournamentCommunityBinding } from "../../utils/communityApi";

type Community = { id: string; name: string };

export function resolveFprCommunitySelection(
  binding: TournamentCommunityBinding | null,
  communities: Community[],
  selectedId: string,
) {
  const publications = binding?.publishedCommunities ?? [];
  const fixedId = binding?.ratingCommunityId
    || publications.find(p => p.role === "RATING_PRIMARY")?.communityId
    || (publications.length === 1 ? publications[0].communityId : "");
  const fixed = Boolean(fixedId || publications.length);
  const nameFor = (id: string) => publications.find(p => p.communityId === id)?.communityName
    || communities.find(c => c.id === id)?.name || id;
  const choices = fixed ? [] : communities.filter(c => /время\s+на\s+друзей/iu.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const communityId = fixed ? fixedId : choices.find(c => c.id === selectedId)?.id || "";
  return {
    fixed, choices, communityId, communityName: nameFor(communityId),
    publishedNames: publications.map(p => nameFor(p.communityId)),
    error: fixed && !fixedId
      ? "Турнир опубликован в нескольких сообществах. Укажите рейтинговое сообщество в настройках публикации и повторите загрузку."
      : null,
  };
}

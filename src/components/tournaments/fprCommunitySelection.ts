import type { TournamentCommunityBinding } from "../../utils/communityApi";

type Community = { id: string; name: string };

export function resolveFprCommunitySelection(
  binding: TournamentCommunityBinding | null,
  communities: Community[],
  selectedId: string,
) {
  const publications = [...new Map((binding?.publishedCommunities ?? [])
    .map(p => [p.communityId, p])).values()];
  const primaryId = binding?.ratingCommunityId
    || (publications.filter(p => p.role === "RATING_PRIMARY").length === 1
      ? publications.find(p => p.role === "RATING_PRIMARY")?.communityId : "")
    || "";
  const fixedId = publications.length === 1 ? publications[0].communityId
    : !publications.length ? primaryId : "";
  const fixed = Boolean(fixedId);
  const nameFor = (id: string) => publications.find(p => p.communityId === id)?.communityName
    || communities.find(c => c.id === id)?.name || id;
  const needsCommunityList = !fixed && !publications.length;
  const choices = fixed ? [] : (publications.length
    ? publications.map(p => ({ id: p.communityId, name: nameFor(p.communityId) }))
    : communities.filter(c => /время\s+на\s+друзей/iu.test(c.name)))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const communityId = fixed ? fixedId
    : choices.find(c => c.id === selectedId)?.id
      || (!selectedId && publications.length ? choices.find(c => c.id === primaryId)?.id : "") || "";
  return {
    fixed, choices, communityId, communityName: nameFor(communityId), needsCommunityList,
    publishedNames: publications.map(p => nameFor(p.communityId)),
    error: null,
  };
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const nodeDir = path.resolve("scripts/nodered_tournament_community_nodes");
const run = (fileName, msg) => {
  const source = fs.readFileSync(path.join(nodeDir, fileName), "utf8");
  return new Function("msg", source)(msg);
};

test("history publication nodes expose all communities and resolve one rating primary", () => {
  const prepared = run("fn_tournament_community_publications_query.js", {
    _tournamentCommunityMode: "history",
    payload: [{ tournamentId: "tournament-1", title: "TFF" }],
  });
  assert.deepEqual(prepared.payload, {
    archived: { $ne: true },
    kind: "TOURNAMENT",
    $or: [
      { relatedTournamentId: "tournament-1" },
      { tournamentId: "tournament-1" },
      { "details.relatedTournamentId": "tournament-1" },
      { "details.publicTournament.exerciseId": "tournament-1" },
      { "details.publicTournament.tournamentId": "tournament-1" },
    ],
  });

  const attached = run("fn_tournament_community_publications_attach.js", {
    ...prepared,
    payload: [
      {
        id: "post-a",
        communityId: "community-a",
        relatedTournamentId: "tournament-1",
        details: { publicationRole: "RATING_PRIMARY", studioId: "station-1" },
      },
      {
        id: "post-b",
        communityId: "community-b",
        relatedTournamentId: "tournament-1",
      },
    ],
  });
  assert.equal(attached.payload[0].ratingCommunityId, "community-a");
  assert.equal(attached.payload[0].ratingCommunityStatus, "RESOLVED");
  assert.deepEqual(attached.payload[0].publishedCommunities.map((row) => row.communityId), [
    "community-a",
    "community-b",
  ]);
});

test("multiple discovery publications remain visible but fail closed for rating selection", () => {
  const prepared = run("fn_tournament_community_publications_query.js", {
    _tournamentCommunityMode: "broadcast",
    payload: [{ tournamentId: "tournament-1" }],
  });
  const attached = run("fn_tournament_community_publications_attach.js", {
    ...prepared,
    payload: [
      { id: "post-a", communityId: "community-a", relatedTournamentId: "tournament-1" },
      { id: "post-b", communityId: "community-b", relatedTournamentId: "tournament-1" },
    ],
  });
  assert.equal(attached.payload[0].ratingCommunityId, null);
  assert.equal(attached.payload[0].ratingCommunityStatus, "AMBIGUOUS");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("scripts/patch_nodered_communities_flow.mjs", "utf8");
const apiSource = fs.readFileSync("src/utils/communityApi.ts", "utf8");

function extractRawTemplate(marker, endMarker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const bodyStart = start + marker.length;
  const end = source.indexOf(endMarker, bodyStart);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return source.slice(bodyStart, end);
}

const commonHelpers = extractRawTemplate("const commonHelpers = String.raw`", "`;\n\nconst fnMediaUpload");
function runFunction(name, nextName, msg) {
  const body = extractRawTemplate(`const ${name} = \`\${commonHelpers}`, `\`;\n\nconst ${nextName}`);
  return new Function("msg", `${commonHelpers}\n${body}`)(msg);
}

const COMMUNITY_ID = "community-tff-station";
const TOURNAMENT_ID = "exercise-tff";
const STATION_ID = "station-tff";
const VERIFIED_MODERATOR = {
  id: "verified-profile",
  phone: "79990000001",
  name: "Verified Moderator",
  role: "MODERATOR",
};
const basePrepareMessage = {
  req: {
    params: { communityId: COMMUNITY_ID },
    headers: { authorization: "Bearer verified-token" },
  },
  payload: {
    member: { id: "spoofed-moderator", role: "OWNER" },
    kind: "TOURNAMENT",
    title: "TFF",
    body: "Tournament",
    relatedTournamentId: TOURNAMENT_ID,
    details: {
      directionId: "malicious-direction",
      studioId: "malicious-station",
      publicationRole: "RATING_PRIMARY",
    },
  },
};

test("feed create sends Bearer to Viva and discards client-supplied actor authority", () => {
  const [prepared, error] = runFunction("fnFeedPostPrepare", "fnFeedPostProfileAuthorize", structuredClone(basePrepareMessage));
  assert.equal(error, null);
  assert.equal(prepared.url, "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile");
  assert.equal(prepared.headers.Authorization, "Bearer verified-token");
  assert.equal(prepared._communityPost.member, undefined);
  assert.equal(prepared._communityPost.verifiedActor, undefined);

  const [, missingAuth] = runFunction("fnFeedPostPrepare", "fnFeedPostProfileAuthorize", {
    ...structuredClone(basePrepareMessage),
    req: { params: { communityId: COMMUNITY_ID }, headers: {} },
  });
  assert.equal(missingAuth.statusCode, 401);
  assert.equal(missingAuth.payload.error, "AUTH_TOKEN_REQUIRED");
});

test("verified profile identity, not spoofed body member, authorizes community role", () => {
  const [prepared] = runFunction("fnFeedPostPrepare", "fnFeedPostProfileAuthorize", structuredClone(basePrepareMessage));
  prepared.statusCode = 200;
  prepared.payload = { id: "verified-profile", phone: "+7 999 000-00-01", name: "Verified Moderator" };
  const [profiled] = runFunction("fnFeedPostProfileAuthorize", "fnFeedPostAuthorize", prepared);
  assert.equal(profiled._communityPost.verifiedActorProfileId, "verified-profile");
  assert.equal(profiled._communityPost.verifiedActor.id, "verified-profile");
  assert.equal(profiled._communityPost.authHeader, undefined);
  assert.deepEqual(profiled.headers, {});

  profiled.payload = [{
    id: COMMUNITY_ID,
    members: [{ ...VERIFIED_MODERATOR, role: "MEMBER" }],
    ratingProgram: { programKey: "TIME_FOR_FRIENDS", stationId: STATION_ID, autoEnrollmentEnabled: false },
  }];
  const memberResult = runFunction("fnFeedPostAuthorize", "fnFeedPostTournamentValidate", profiled);
  assert.equal(memberResult[2].statusCode, 403);

  profiled.payload[0].members[0].role = "MODERATOR";
  const moderatorResult = runFunction("fnFeedPostAuthorize", "fnFeedPostTournamentValidate", profiled);
  assert.equal(moderatorResult[0], null);
  assert.equal(moderatorResult[1].url, `https://api.vivacrm.ru/end-user/api/v1/iSkq6G/exercises/${TOURNAMENT_ID}`);
});

test("TFF provider metadata must match exact community station before validation", () => {
  const context = {
    kind: "TOURNAMENT",
    relatedTournamentId: TOURNAMENT_ID,
    community: {
      ratingProgram: { programKey: "TIME_FOR_FRIENDS", stationId: STATION_ID, autoEnrollmentEnabled: false },
    },
  };
  const [validated] = runFunction("fnFeedPostTournamentValidate", "fnFeedPostFinalize", {
    _communityPost: context,
    statusCode: 200,
    payload: {
      id: TOURNAMENT_ID,
      direction: { id: 5278, name: "Время на друзей" },
      studio: { id: STATION_ID, name: "Station" },
    },
  });
  assert.deepEqual(validated._communityPost.pendingServerValidation, {
    tournamentId: TOURNAMENT_ID,
    stationId: STATION_ID,
    status: "VALIDATED",
  });

  const [, stationConflict] = runFunction("fnFeedPostTournamentValidate", "fnFeedPostFinalize", {
    _communityPost: context,
    statusCode: 200,
    payload: {
      id: TOURNAMENT_ID,
      direction: { id: 5278 },
      studio: { id: "different-station" },
    },
  });
  assert.equal(stationConflict.statusCode, 409);
  assert.equal(stationConflict.payload.error, "TOURNAMENT_STATION_SCOPE_CONFLICT");

  const [, idConflict] = runFunction("fnFeedPostTournamentValidate", "fnFeedPostFinalize", {
    _communityPost: context,
    statusCode: 200,
    payload: {
      id: "different-exercise",
      direction: { id: 5278 },
      studio: { id: STATION_ID },
    },
  });
  assert.equal(idConflict.statusCode, 409);
  assert.equal(idConflict.payload.error, "TOURNAMENT_ID_NOT_VERIFIED");
});

test("provider-verified non-TFF tournament remains publication-only", () => {
  const [validated] = runFunction("fnFeedPostTournamentValidate", "fnFeedPostFinalize", {
    _communityPost: {
      kind: "TOURNAMENT",
      relatedTournamentId: TOURNAMENT_ID,
      community: {
        ratingProgram: { programKey: "TIME_FOR_FRIENDS", stationId: STATION_ID, autoEnrollmentEnabled: false },
      },
    },
    statusCode: 200,
    payload: {
      id: TOURNAMENT_ID,
      direction: { id: 5280, name: "Other tournament" },
      studio: { id: STATION_ID, name: "Station" },
    },
  });
  assert.equal(validated._communityPost.pendingServerValidation, null);
  assert.equal(validated._communityPost.providerTournament.directionId, "5280");
});

test("finalizer persists server evidence and exact ratingProgram validation row", () => {
  const [feed, event, communityUpdate, response] = runFunction("fnFeedPostFinalize", "fnFeedArchivePrepare", {
    _communityPost: {
      communityId: COMMUNITY_ID,
      kind: "TOURNAMENT",
      title: "TFF",
      body: "Tournament",
      relatedTournamentId: TOURNAMENT_ID,
      details: { directionId: "malicious-direction", studioId: "malicious-station", publicationRole: "RATING_PRIMARY" },
      verifiedActorProfileId: VERIFIED_MODERATOR.id,
      actorMember: VERIFIED_MODERATOR,
      providerTournament: {
        tournamentId: TOURNAMENT_ID,
        directionId: "5278",
        directionName: "Время на друзей",
        stationId: STATION_ID,
        stationName: "Station",
      },
      pendingServerValidation: { tournamentId: TOURNAMENT_ID, stationId: STATION_ID, status: "VALIDATED" },
    },
  });
  assert.equal(feed.payload.author.id, VERIFIED_MODERATOR.id);
  assert.equal(feed.payload.details.directionId, "5278");
  assert.equal(feed.payload.details.studioId, STATION_ID);
  assert.equal(feed.payload.serverValidation.status, "VALIDATED");
  assert.equal(feed.payload.serverValidation.actorProfileId, VERIFIED_MODERATOR.id);
  assert.deepEqual(communityUpdate.payload.$addToSet["ratingProgram.validatedPublications"], {
    publicationId: feed.payload.id,
    tournamentId: TOURNAMENT_ID,
    stationId: STATION_ID,
    status: "VALIDATED",
  });
  assert.equal(event.payload.payload.serverValidationStatus, "VALIDATED");
  assert.equal(response.statusCode, 200);
});

test("flow topology includes both server verification calls and frontend sends auth", () => {
  assert.match(source, /community_feed_post_profile_request_20260811/);
  assert.match(source, /community_feed_post_tournament_request_20260811/);
  assert.match(source, /ratingProgram\.validatedPublications/);
  const createStart = apiSource.indexOf("export async function apiCreateCommunityFeedPost");
  const createEnd = apiSource.indexOf("export async function apiUpdateCommunityFeedPost", createStart);
  assert.notEqual(createStart, -1);
  assert.match(apiSource.slice(createStart, createEnd), /method: "POST",\s*auth: true,/);
});

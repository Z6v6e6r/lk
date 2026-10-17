import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import {
  getIdentityKey,
  getIdentityMessageKey,
  isViewerIdentity,
} from "../../src/utils/viewerIdentity.ts";

// Execute the actual pure adapters/UI selectors without loading browser modules or calling APIs.
function loadFunctions(file, names, dependencies = {}) {
  const source = fs.readFileSync(file, "utf8");
  const functions = names.map((name) => {
    const start = source.search(new RegExp(`^(?:export )?function ${name}\\(`, "m"));
    assert.ok(start >= 0, `missing ${name} in ${file}`);
    const tail = source.slice(start + 1);
    const next = tail.search(/^(?:export )?(?:async )?function [\w]+\(/m);
    assert.ok(next >= 0, `missing boundary after ${name}`);
    return source.slice(start, start + 1 + next);
  });
  const js = stripTypeScriptTypes(functions.join("\n"));
  return new Function(...Object.keys(dependencies), `${js}\nreturn { ${names.join(", ")} };`)(...Object.values(dependencies));
}

const syntheticPhone = "70000000001";
const viewer = { id: "client-viewer", phone: "+" + syntheticPhone };
const alias = `pp_${"a".repeat(32)}`;
const otherAlias = `pp_${"b".repeat(32)}`;

test("viewer markers support opaque IDs and contextless false preserves stable identity", () => {
  assert.equal(isViewerIdentity({ id: alias, isViewer: true }, viewer), true);
  assert.equal(isViewerIdentity({ id: viewer.id, isViewer: false }, viewer), true);
  assert.equal(isViewerIdentity({ id: otherAlias, isViewer: false }, viewer), false);
  assert.equal(isViewerIdentity({ id: "client-viewer" }, viewer), true);
  assert.equal(isViewerIdentity({ phone: "8" + syntheticPhone.slice(1) }, viewer), true);
  assert.equal(isViewerIdentity({ id: otherAlias }, viewer), false);
  assert.equal(isViewerIdentity(null, viewer), false);
});

test("game chat parsers retain safe sender identity and do not invent absent markers", () => {
  const api = loadFunctions("src/utils/apiClient.ts", [
    "isRecord", "toTrimmedString", "pickString", "pickNumber", "toNumeric", "toCountNumber", "toBoolean",
    "normalizeChatMessageSender", "normalizePadelGameChatMessage", "extractPadelChatsByPhone",
  ]);
  const sender = { id: alias, name: "Игрок", isViewer: true };
  const message = api.normalizePadelGameChatMessage({
    messageId: "message-1", gameId: "game-1", text: "Тест", createdTs: 123, sender,
  });
  assert.equal(message.sender.id, alias);
  assert.equal(message.sender.phoneNorm, null);
  assert.equal(message.sender.isViewer, true);
  const summary = api.extractPadelChatsByPhone({
    chats: [{ gameId: "game-1", lastMessage: { createdTs: 123, text: "Тест", sender } }],
  }).chats[0];
  assert.equal(summary.lastMessageSenderId, alias);
  assert.equal(summary.lastMessageIsViewer, true);
  assert.equal(summary.lastMessageSenderPhone, null);
  const legacySender = api.normalizeChatMessageSender({ id: "client-viewer", phoneNorm: syntheticPhone });
  assert.equal(Object.hasOwn(legacySender, "isViewer"), false);
  assert.equal(isViewerIdentity({ id: legacySender.id, phone: legacySender.phoneNorm }, viewer), true);
  assert.equal(api.normalizeChatMessageSender({ ...sender, isViewer: false }).isViewer, false);
});

test("polling dedupes the same message by message ID after phone removal", () => {
  const game = loadFunctions("src/components/games/GamesPage.tsx", [
    "mergeChatMessages", "getChatSenderStableKey",
  ], { getIdentityKey, getIdentityMessageKey });
  const oldMessage = { id: "message-1", createdTs: 123, text: "Тест", sender: { id: alias, phoneNorm: syntheticPhone } };
  const redacted = { ...oldMessage, sender: { id: alias, isViewer: true } };
  const sameTimeForeign = { ...redacted, id: "message-2", sender: { id: otherAlias } };
  const merged = game.mergeChatMessages([oldMessage], [redacted, sameTimeForeign]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], redacted);
  assert.equal(game.getChatSenderStableKey(oldMessage), game.getChatSenderStableKey(redacted));
  assert.notEqual(game.getChatSenderStableKey(redacted), game.getChatSenderStableKey(sameTimeForeign));
});

const community = loadFunctions("src/utils/communityApi.ts", [
  "isRecord", "toTrimmedString", "toNumeric", "toCountNumber", "pickString", "pickNumber",
  "normalizePhone", "normalizeRole", "normalizeMembershipStatus", "normalizeCommunityMember",
  "communityAuthorViewerMarker", "normalizeCommunityPostComment", "normalizeCommunityChatMessage",
  "normalizeCommunityRatingItem",
]);

test("community member, author and ranking adapters retain markers without telephone fields", () => {
  const member = community.normalizeCommunityMember({ id: alias, name: "Игрок", role: "ADMIN", isViewer: true });
  assert.equal(member.phone, null);
  assert.equal(member.isViewer, true);
  const author = { id: alias, name: "Игрок", isViewer: true };
  const raw = { id: "message-1", communityId: "community-1", postId: "post-1", text: "Тест", author };
  assert.equal(community.normalizeCommunityChatMessage(raw).authorIsViewer, true);
  assert.equal(community.normalizeCommunityPostComment(raw).authorIsViewer, true);
  assert.equal(community.normalizeCommunityChatMessage({ ...raw, authorIsViewer: false }).authorIsViewer, false);
  assert.equal(community.normalizeCommunityRatingItem({ playerId: alias, playerName: "Игрок", isViewer: true }, 0, "community-1").isViewer, true);
  assert.equal(Object.hasOwn(community.normalizeCommunityChatMessage({ ...raw, author: { id: "old-client" } }), "authorIsViewer"), false);
});

test("own opaque community member keeps membership and cannot be managed as a foreign member", () => {
  const selectors = loadFunctions("src/components/cabinet/CommunitiesSection.tsx", [
    "canManageCommunityMember", "isCommunityMember", "findCommunityMember",
  ], { isViewerIdentity });
  const own = community.normalizeCommunityMember({ id: alias, name: "Одинаковое имя", role: "ADMIN", isViewer: true });
  const foreign = community.normalizeCommunityMember({ id: otherAlias, name: "Одинаковое имя", role: "MEMBER", isViewer: false });
  const group = { members: [foreign, own] };
  assert.equal(selectors.isCommunityMember(group, viewer.id, viewer.phone), true);
  assert.equal(selectors.findCommunityMember(group, viewer.id, viewer.phone), own);
  assert.equal(selectors.canManageCommunityMember("OWNER", own, viewer.id, viewer.phone), false);
  assert.equal(selectors.canManageCommunityMember("OWNER", foreign, viewer.id, viewer.phone), true);
  assert.equal(selectors.isCommunityMember({ members: [foreign] }, viewer.id, viewer.phone), false);
});

test("community chat groups by stable author IDs and respects explicit own-message markers", () => {
  const chat = loadFunctions("src/components/cabinet/community-feed/CommunityChatScreen.tsx", [
    "normalizeIdentity", "normalizePhone", "isMineMessage", "areMessagesFromSameAuthor",
  ], { isViewerIdentity, getIdentityKey });
  const own = { authorId: alias, authorName: "Одинаковое имя", authorIsViewer: true };
  const other = { authorId: otherAlias, authorName: "Одинаковое имя", authorIsViewer: false };
  assert.equal(chat.isMineMessage(own, viewer.id, viewer.phone), true);
  assert.equal(chat.isMineMessage(other, viewer.id, viewer.phone), false);
  assert.equal(chat.areMessagesFromSameAuthor(own, { ...own }), true);
  assert.equal(chat.areMessagesFromSameAuthor(own, other), false);
  assert.equal(chat.areMessagesFromSameAuthor({ ...own, authorPhone: viewer.phone }, { ...other, authorPhone: viewer.phone }), false);
});

test("feed edit affordance uses author marker with legacy fallback", () => {
  const feed = loadFunctions("src/components/cabinet/community-feed/feedAdapter.ts", [
    "normalizePhone", "isCurrentUserAuthorOfPost",
  ], { isViewerIdentity });
  assert.equal(feed.isCurrentUserAuthorOfPost({ authorId: alias, authorIsViewer: true }, viewer.id, viewer.phone), true);
  assert.equal(feed.isCurrentUserAuthorOfPost({ authorId: viewer.id, authorIsViewer: false }, viewer.id, viewer.phone), true);
  assert.equal(feed.isCurrentUserAuthorOfPost({ memberPreview: { id: alias, isViewer: true } }, viewer.id, viewer.phone), true);
  assert.equal(feed.isCurrentUserAuthorOfPost({ authorPhone: viewer.phone }, viewer.id, viewer.phone), true);
});

test("game feed and community autopublish preserve own identity without reviving inactive membership", () => {
  const feed = loadFunctions("src/components/cabinet/community-feed/feedAdapter.ts", [
    "isInactiveGameMembershipStatus", "normalizeIdentityId", "playerMatchesIdentity",
  ], {
    isViewerIdentity,
    INACTIVE_GAME_MEMBERSHIP_STATUS_MARKERS: ["LEFT", "REMOV", "CANCEL"],
  });
  const games = loadFunctions("src/components/games/GamesPage.tsx", ["isCommunityMemberForAutopublish"], {
    isViewerIdentity,
  });
  const own = { id: alias, isViewer: true, status: "ACTIVE" };
  const foreign = { id: otherAlias, isViewer: false, status: "ACTIVE" };
  assert.equal(feed.playerMatchesIdentity(own, viewer.id, viewer.phone), true);
  assert.equal(feed.playerMatchesIdentity({ ...own, status: "LEFT" }, viewer.id, viewer.phone), false);
  assert.equal(feed.playerMatchesIdentity(foreign, viewer.id, viewer.phone), false);
  assert.equal(games.isCommunityMemberForAutopublish({ members: [own] }, viewer.id, viewer.phone), true);
  assert.equal(games.isCommunityMemberForAutopublish({ members: [foreign] }, viewer.id, viewer.phone), false);
});

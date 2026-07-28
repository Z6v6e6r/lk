import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

function unreadPollingBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing unread polling marker: ${marker}`);
  return source.slice(markerIndex, markerIndex + 2_400);
}

test("cabinet polls game chat unread state every 20 seconds", () => {
  const block = unreadPollingBlock(cabinetSource, "apiFetchPadelChatsByPhone(profilePhoneNorm)");
  assert.match(block, /window\.setInterval\([\s\S]*?, 20000\);/);
  assert.doesNotMatch(block, /, 12000\);/);
});

test("games page polls game chat unread state every 20 seconds", () => {
  const block = unreadPollingBlock(gamesPageSource, "await refreshUnreadChats();");
  assert.match(block, /window\.setInterval\([\s\S]*?, 20000\);/);
  assert.doesNotMatch(block, /, 12000\);/);
});

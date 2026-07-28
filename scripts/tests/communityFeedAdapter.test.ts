import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundleDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "community-feed-adapter-test-"));
const bundlePath = path.join(bundleDirectory, "feedAdapter.mjs");
await build({
  entryPoints: ["src/components/cabinet/community-feed/feedAdapter.ts"],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  define: {
    "import.meta.env": "{}",
  },
  logLevel: "silent",
});
const { buildFeedEntries } = await import(pathToFileURL(bundlePath).href) as typeof import(
  "../../src/components/cabinet/community-feed/feedAdapter.ts"
);
process.on("exit", () => fs.rmSync(bundleDirectory, { recursive: true, force: true }));

test("community feed game card resolves result teams from latest set pairing and snapshot member keys", () => {
  const entries = buildFeedEntries({
    community: {
      id: "community-1",
      name: "Тестовое сообщество",
      members: [],
      minimumLevel: "D+",
    },
    posts: [
      {
        id: "post-game-1",
        kind: "GAME",
        title: "Результат игры",
        body: "",
        imageUrl: null,
        publishedAt: "2026-05-29T12:30:00.000Z",
        createdAt: "2026-05-29T12:30:00.000Z",
        relatedGameId: "game-1",
        memberPreview: null,
        authorName: "Организатор",
      },
    ] as never,
    games: [
      {
        id: "game-1",
        organizer: {
          id: "organizer-1",
          name: "Организатор",
          phone: "+7 900 000-00-09",
          photo: null,
        },
        booking: {
          date: "2026-05-29",
          timeFrom: "10:00",
          timeTo: "11:30",
          durationMinutes: 90,
        },
        participants: [
          { id: "p1", name: "Анна", phone: "+7 900 000-00-01", photo: "anna.png", rating: "C" },
          { id: "p2", name: "Борис", phone: "+7 900 000-00-02", photo: "boris.png", rating: "C" },
          { id: "p3", name: "Виктор", phone: "+7 900 000-00-03", photo: "victor.png", rating: "C" },
          { id: "p4", name: "Глеб", phone: "+7 900 000-00-04", photo: "gleb.png", rating: "C" },
        ],
        waitlist: [
          { id: "p5", name: "Денис", phone: "+7 900 000-00-05", photo: "denis.png", rating: "C" },
        ],
        settings: {
          ratingGame: true,
          minRating: "C",
          maxRating: "C+",
        },
        metadata: {
          teamSlots: ["p1", "p2", "p3", "p4"],
          matchResult: {
            status: "CONFIRMED",
            sets: [
              { left: 6, right: 4 },
              { left: 4, right: 6 },
            ],
            setPairings: [
              { slots: ["mk1", "mk2", "mk3", "mk4"] },
              { slots: ["mk1", "mk5", "mk3", "mk4"] },
            ],
            resultRosterSnapshot: {
              members: [
                { memberKey: "mk1", id: "p1", phone: "+7 900 000-00-01", name: "Анна", photo: "anna.png" },
                { memberKey: "mk2", id: "p2", phone: "+7 900 000-00-02", name: "Борис", photo: "boris.png" },
                { memberKey: "mk3", id: "p3", phone: "+7 900 000-00-03", name: "Виктор", photo: "victor.png" },
                { memberKey: "mk4", id: "p4", phone: "+7 900 000-00-04", name: "Глеб", photo: "gleb.png" },
                { memberKey: "mk5", id: "p5", phone: "+7 900 000-00-05", name: "Денис", photo: "denis.png" },
              ],
            },
          },
        },
      },
    ] as never,
    tournamentStats: {},
    currentUser: {},
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.item.type, "game");
  if (entries[0]?.item.type !== "game") {
    throw new Error("expected game feed item");
  }

  assert.deepEqual(
    entries[0].item.data.resultTeams,
    {
      left: [
        { id: "p1", name: "Анна", avatarUrl: "anna.png", avatar: "anna.png", level: "C" },
        { id: "p5", name: "Денис", avatarUrl: "denis.png", avatar: "denis.png", level: "C" },
      ],
      right: [
        { id: "p3", name: "Виктор", avatarUrl: "victor.png", avatar: "victor.png", level: "C" },
        { id: "p4", name: "Глеб", avatarUrl: "gleb.png", avatar: "gleb.png", level: "C" },
      ],
    },
  );
});

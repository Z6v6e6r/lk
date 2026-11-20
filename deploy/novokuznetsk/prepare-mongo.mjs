import { MongoClient } from "mongodb";
import { INDEX_KEY as publicGamesKey, INDEX_NAME as publicGamesName } from "../../scripts/manage_lk_games_public_index.mjs";
import { LK_GAMES_LOOKUP_INDEX_SPEC } from "../../scripts/manage_lk_games_lookup_index.mjs";

const database = "lk1_novokuznetsk";
const collections = {
  lk_games: [
    { name: "uniq_tenant_game_id", key: { tenantKey: 1, id: 1 }, unique: true },
    { name: publicGamesName, key: publicGamesKey },
    { name: "schedule_station_date_time_v1", key: {
      "booking.studioName": 1, "booking.date": 1, "booking.timeFromIso": 1, "booking.timeFrom": 1,
    } },
    { key: LK_GAMES_LOOKUP_INDEX_SPEC.key, ...LK_GAMES_LOOKUP_INDEX_SPEC.options },
  ],
  lk_communities: [
    { name: "novokuznetsk_community_id", key: { id: 1 } },
    { name: "novokuznetsk_community_invite", key: { inviteCode: 1 } },
  ],
  lk_community_rankings: [{ name: "novokuznetsk_ranking_community", key: { communityId: 1 } }],
  lk_community_feed: [{ name: "community_feed_created_ts_v1", key: { communityId: 1, createdTs: -1 } }],
  lk_community_events: [],
  lk_club_booking_operations: [],
  lk_auth_consents: [],
  lk_player_levels: [],
  lk_game_rating_events: [],
};
const report = { database, collections };
const mode = process.argv[2] ?? "--plan";
if (mode === "--plan") {
  console.log(JSON.stringify(report, null, 2));
} else if (mode === "--apply-local") {
  const uri = process.env.NVK_MONGO_ADMIN_URI || "";
  const username = "lk1_novokuznetsk_backend";
  const password = process.env.NVK_MONGO_BACKEND_PASSWORD || "";
  if (!/^mongodb:\/\/[^/@]+@127\.0\.0\.1:[1-9][0-9]{3,4}\/admin$/.test(uri)
    || password.length < 24) {
    throw new Error("Supply a dedicated local admin URI on 127.0.0.1 and a backend password of at least 24 characters");
  }

  const options = { directConnection: true, serverSelectionTimeoutMS: 5000 };
  const client = new MongoClient(uri, options);
  const host = new URL(uri).host;
  const backendClient = new MongoClient(
    `mongodb://${username}:${encodeURIComponent(password)}@${host}/${database}`, options,
  );
  try {
    await client.connect();
    const admin = client.db("admin");
    const { databases } = await admin.command({ listDatabases: 1, nameOnly: true, authorizedDatabases: false });
    const expected = new Set(["admin", "local", "config", database]);
    if (databases.some(({ name }) => !expected.has(name))) {
      throw new Error("The local MongoDB instance has other application databases");
    }

    const db = client.db(database);
    const roles = [{ role: "readWrite", db: database }];
    const { users } = await db.command({ usersInfo: username });
    if (users.length > 0) {
      if (users[0].roles.length !== 1
        || users[0].roles[0].db !== database || users[0].roles[0].role !== "readWrite") {
        throw new Error("The existing backend user has unexpected MongoDB privileges");
      }
      await backendClient.connect();
    }
    const existing = await db.listCollections({}, { nameOnly: true }).toArray();
    if (existing.some(({ name }) => !Object.hasOwn(collections, name))) {
      throw new Error("The target database contains collections outside the schema");
    }
    for (const { name } of existing) {
      if (await db.collection(name).estimatedDocumentCount() !== 0) {
        throw new Error("Local schema initialization requires an empty target database");
      }
    }

    const existingNames = new Set(existing.map(({ name }) => name));
    for (const [name, indexes] of Object.entries(collections)) {
      if (!existingNames.has(name)) await db.createCollection(name);
      if (indexes.length) await db.collection(name).createIndexes(indexes);
    }

    if (users.length === 0) {
      await db.command({ createUser: username, pwd: password, roles });
      await backendClient.connect();
    }
    const verifiedCollections = [];
    for (const name of Object.keys(collections)) {
      const collection = backendClient.db(database).collection(name);
      const indexes = (await collection.indexes()).map((index) => index.name).sort();
      verifiedCollections.push({ name, documents: await collection.estimatedDocumentCount(), indexes });
    }
    console.log(JSON.stringify({ database, username, collections: verifiedCollections }, null, 2));
  } finally {
    await Promise.all([client.close(), backendClient.close()]);
  }
} else {
  throw new Error("Usage: node deploy/novokuznetsk/prepare-mongo.mjs [--plan|--apply-local]");
}

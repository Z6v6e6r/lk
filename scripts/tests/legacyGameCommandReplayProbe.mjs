import { MongoClient } from "mongodb";

import { LegacyGameCommandTransactionService } from "../../node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-core.mjs";

const probe = JSON.parse(process.env.LEGACY_COMMAND_REPLAY_PROBE || "null");
if (!probe?.mongoUri || !probe?.databaseName || !probe?.input) throw new Error("Replay probe configuration is required");

const client = new MongoClient(probe.mongoUri, { readPreference: "primary", serverSelectionTimeoutMS: 10_000 });
try {
  await client.connect();
  const service = new LegacyGameCommandTransactionService({ client, db: client.db(probe.databaseName) });
  const result = await service.executeLegacyGameCommandTransaction({
    ...probe.input,
    buildMutation: () => { throw new Error("restarted process must not execute a terminal command"); },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await client.close();
}

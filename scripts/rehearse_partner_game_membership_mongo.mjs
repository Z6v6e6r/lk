#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MongoPartnerGameMembershipRepository, PARTNER_MEMBERSHIP_COLLECTIONS } from "../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs";

const DATABASE_PATTERN = /^lk_partner_rehearsal_[a-z0-9][a-z0-9_-]{2,48}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const queryOf = (uri) => {
  const marker = uri.indexOf("?");
  return new URLSearchParams(marker === -1 ? "" : uri.slice(marker + 1));
};

const hostsOf = (uri) => {
  const match = /^mongodb:\/\/([^/]+)(?:\/|$)/i.exec(uri);
  if (!match) throw new Error("Mongo rehearsal URI must use mongodb://");
  const authority = match[1].slice(match[1].lastIndexOf("@") + 1);
  return authority.split(",").map((entry) => {
    const host = entry.startsWith("[")
      ? entry.slice(1, entry.indexOf("]"))
      : entry.split(":")[0];
    return host.toLowerCase();
  });
};

const advertisedHost = (entry) => {
  const text = String(entry || "").trim().toLowerCase();
  if (text.startsWith("[")) return text.slice(1, text.indexOf("]"));
  return text.split(":")[0];
};

export function validatePartnerMongoRehearsalTarget({ mongoUri, databaseName, acknowledgedDatabase }) {
  const uri = String(mongoUri || "").trim();
  const database = String(databaseName || "").trim();
  const acknowledgement = String(acknowledgedDatabase || "").trim();
  const hosts = hostsOf(uri);
  if (!hosts.length || hosts.some((host) => !LOOPBACK_HOSTS.has(host))) {
    throw new Error("Mongo rehearsal accepts only loopback hosts");
  }
  if (!DATABASE_PATTERN.test(database)) {
    throw new Error("Mongo rehearsal database must match lk_partner_rehearsal_<isolated-name>");
  }
  if (acknowledgement !== database) {
    throw new Error("Mongo rehearsal requires an exact disposable database acknowledgement");
  }
  const query = queryOf(uri);
  const optionValues = (name) => [...query.entries()]
    .filter(([key]) => key.trim().toLowerCase() === name.toLowerCase())
    .map(([, value]) => String(value || "").trim());
  const directConnectionValues = optionValues("directConnection");
  if (directConnectionValues.length > 1) {
    throw new Error("Mongo rehearsal rejects duplicate directConnection URI options");
  }
  if (
    directConnectionValues.length === 1
    && directConnectionValues[0].toLowerCase() !== "false"
  ) {
    throw new Error("Mongo rehearsal requires replica-set discovery, not directConnection");
  }
  const replicaSetValues = optionValues("replicaSet");
  if (replicaSetValues.length !== 1 || !replicaSetValues[0]) {
    throw new Error("Mongo rehearsal requires exactly one explicit replicaSet URI option");
  }
  const [replicaSet] = replicaSetValues;
  return { mongoUri: uri, databaseName: database, hosts, replicaSet };
}

export async function runPartnerMongoRehearsal(options = {}) {
  const target = validatePartnerMongoRehearsalTarget(options);
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(target.mongoUri, {
    readPreference: "primary",
    retryReads: true,
    retryWrites: true,
    serverSelectionTimeoutMS: 10_000,
  });
  let indexesCreated = false;
  let transactionAborted = false;
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (
      String(hello?.setName || "").trim() !== target.replicaSet
      || !Number.isFinite(hello?.logicalSessionTimeoutMinutes)
    ) {
      throw new Error("Mongo rehearsal target is not a transaction-capable replica set");
    }
    const db = client.db(target.databaseName);
    const advertised = [hello.me, hello.primary, ...(hello.hosts || []), ...(hello.passives || []), ...(hello.arbiters || [])]
      .filter(Boolean)
      .map(advertisedHost);
    if (!advertised.length || advertised.some((host) => !LOOPBACK_HOSTS.has(host))) {
      throw new Error("Mongo rehearsal replica set advertises a non-loopback member");
    }
    const existingCollections = await db.listCollections({}, { nameOnly: true }).toArray();
    const allowedCollections = new Set(Object.values(PARTNER_MEMBERSHIP_COLLECTIONS));
    if (existingCollections.some(({ name }) => !allowedCollections.has(name))) {
      throw new Error("Mongo rehearsal database contains an unexpected collection");
    }
    for (const { name } of existingCollections) {
      if (await db.collection(name).estimatedDocumentCount() !== 0) {
        throw new Error("Mongo rehearsal database must not contain documents");
      }
    }
    const repository = new MongoPartnerGameMembershipRepository({ client, db, ownsClient: false });
    await repository.ensureIndexesForIsolatedTest();
    indexesCreated = true;
    await repository.verifyRequiredIndexes();

    const sentinelId = `rehearsal:${crypto.randomUUID()}`;
    const session = client.startSession();
    try {
      session.startTransaction({
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      });
      await db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.audit).insertOne({
        _id: sentinelId,
        type: "PARTNER_API_REHEARSAL_SENTINEL",
        at: new Date(),
      }, { session });
      await session.abortTransaction();
      transactionAborted = true;
    } finally {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});
      await session.endSession();
    }
    const leaked = await db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.audit).findOne({ _id: sentinelId });
    if (leaked) throw new Error("Mongo rehearsal transaction sentinel survived abort");
    return {
      databaseName: target.databaseName,
      replicaSetName: hello.setName,
      indexesCreated,
      transactionAborted,
      sentinelAbsent: true,
      productionTargetAccepted: false,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || args.has(key)) throw new Error("Invalid rehearsal arguments");
    args.set(key, value);
  }
  if (args.size !== 1 || !args.has("--ack-disposable-db")) {
    throw new Error("Usage: --ack-disposable-db <exact LK_PARTNER_GAME_API_MONGO_DB value>");
  }
  return args.get("--ack-disposable-db");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const acknowledgedDatabase = parseArgs(process.argv.slice(2));
    const result = await runPartnerMongoRehearsal({
      mongoUri: process.env.LK_PARTNER_GAME_API_MONGO_URI,
      databaseName: process.env.LK_PARTNER_GAME_API_MONGO_DB,
      acknowledgedDatabase,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

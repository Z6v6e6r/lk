import { readFile, readlink } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { MongoClient } from "mongodb";

if (process.env.NVK_BOOTSTRAP_NETNS !== "1") throw new Error("Requires the isolated bootstrap network namespace");
const [hostNet, currentNet] = await Promise.all([readlink("/proc/1/ns/net"), readlink("/proc/self/ns/net")]);
if (hostNet === currentNet) throw new Error("Refusing MongoDB bootstrap in the host network namespace");
const database = "lk1_novokuznetsk";
const administrator = process.env.NVK_BOOTSTRAP_ADMIN_PASSWORD;
const backend = process.env.NVK_BOOTSTRAP_BACKEND_PASSWORD;
if (!/^[a-f0-9]{64}$/.test(administrator || "") || !/^[a-f0-9]{64}$/.test(backend || "") || administrator === backend) {
  throw new Error("Invalid generated database passwords");
}
const schema = JSON.parse(await readFile(process.argv[2], "utf8"));
if (schema.database !== database) throw new Error("Invalid database name");
const client = new MongoClient("mongodb://127.0.0.1:27039/", { directConnection: true, serverSelectionTimeoutMS: 10000 });
try {
  const admin = client.db("admin");
  await admin.command({ replSetInitiate: { _id: "lk1Nvk89", members: [{ _id: 0, host: "127.0.0.1:27039" }] } });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) { ready = true; break; }
    await setTimeout(250);
  }
  if (!ready) throw new Error("MongoDB did not become primary");
  await admin.command({ createUser: "lk1_novokuznetsk_admin", pwd: administrator, roles: [{ role: "root", db: "admin" }] });
  const db = client.db(database);
  await db.command({ createUser: "lk1_novokuznetsk_backend", pwd: backend, roles: [{ role: "readWrite", db: database }] });
  for (const [name, indexes] of Object.entries(schema.collections)) {
    await db.createCollection(name);
    if (indexes.length) await db.collection(name).createIndexes(indexes);
  }
  console.log(JSON.stringify({ replicaSet: "lk1Nvk89", database, collections: Object.keys(schema.collections).length }));
} finally {
  await client.close();
}

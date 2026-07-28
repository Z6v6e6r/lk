import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const transformProgram = `
  import { transformFlowToMongo4 } from "./scripts/nodered_mongodb4_transform.mjs";
  const transformed = transformFlowToMongo4([
    { id: "mongo-read", type: "mongodb4", z: "games-tab", wires: [] },
  ]);
  const client = transformed.find((node) => node.type === "mongodb4-client");
  process.stdout.write(String(client?.uri || ""));
`;

function runTransform(uri) {
  const env = { ...process.env };
  delete env.NODERED_GAMES_MONGODB_URI;
  if (uri) env.NODERED_GAMES_MONGODB_URI = uri;
  return spawnSync(process.execPath, ["--input-type=module", "-e", transformProgram], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

test("Mongo4 flow conversion fails closed without an injected connection URI", () => {
  const result = runTransform("");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NODERED_GAMES_MONGODB_URI is required/);
});

test("Mongo4 flow conversion injects the connection URI from the environment", () => {
  const uri = "mongodb://example.invalid/games";
  const result = runTransform(uri);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, uri);
});

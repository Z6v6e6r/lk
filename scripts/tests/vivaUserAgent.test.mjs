import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NODE_RED_USER_AGENT_HEADER,
  applyVivaUserAgent,
  discoverVivaHttpRequestNodes,
  publishVivaUserAgentCandidate,
} from "../patch_live_viva_user_agent.mjs";
import {
  PADLHUB_VIVA_USER_AGENT,
  createVivaFetch,
  isVivaHostname,
  isVivaUrl,
  validateVivaUserAgent,
} from "../lib/vivaUserAgent.mjs";

const TEMP_ROOTS = [];

function tempRoot() {
  const created = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lk-viva-ua-")));
  TEMP_ROOTS.push(created);
  return created;
}

test.after(() => {
  for (const directory of TEMP_ROOTS) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function configuredHeader(keyValue, valueValue) {
  return {
    keyType: "other",
    keyValue,
    valueType: "other",
    valueValue,
  };
}

function flowFixture() {
  return [
    { id: "tab-main", type: "tab", label: "Viva integration", disabled: false },
    {
      id: "prepare-viva",
      type: "function",
      z: "tab-main",
      name: "Prepare request",
      func: "msg.url = 'https://api.vivacrm.ru/api/v1/exercises'; return msg;",
      wires: [["request-viva"]],
    },
    {
      id: "prepare-shared-local",
      type: "function",
      z: "tab-main",
      name: "Prepare shared local branch",
      func: "msg.url = 'https://padlhub.su/lk'; return msg;",
      wires: [["request-viva"]],
    },
    {
      id: "request-viva",
      type: "http request",
      z: "tab-main",
      name: "Viva API",
      url: "",
      headers: [configuredHeader("Accept", "application/json")],
      wires: [[]],
    },
    {
      id: "request-token",
      type: "http request",
      z: "tab-main",
      name: "Viva token",
      url: "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token",
      wires: [[]],
    },
    {
      id: "prepare-helpdesk",
      type: "function",
      z: "tab-main",
      name: "Prepare helpdesk",
      func: "msg.url = `https://helpdesk.vivacrm.ru/api/dialogs`; return msg;",
      wires: [["queue-helpdesk"]],
    },
    {
      id: "queue-helpdesk",
      type: "delay",
      z: "tab-main",
      name: "Queue",
      wires: [["request-helpdesk"]],
    },
    {
      id: "request-helpdesk",
      type: "http request",
      z: "tab-main",
      name: "Viva helpdesk",
      url: "",
      wires: [[]],
    },
    {
      id: "prepare-local",
      type: "function",
      z: "tab-main",
      name: "Viva sync via local API",
      func: "msg.url = 'https://padlhub.su/lk/onboarding/level'; return msg;",
      wires: [["request-local"]],
    },
    {
      id: "request-local",
      type: "http request",
      z: "tab-main",
      name: "Viva label only",
      url: "",
      wires: [[]],
    },
    {
      id: "request-lookalike",
      type: "http request",
      z: "tab-main",
      name: "Lookalike",
      url: "https://api.vivacrm.ru.evil.example/api",
      wires: [[]],
    },
    {
      id: "route",
      type: "http in",
      z: "tab-main",
      name: "Route",
      method: "get",
      url: "/test",
      wires: [["prepare-viva"]],
    },
  ];
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function workspaceFixture() {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  const input = path.join(workspace, "input");
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);
  const flow = flowFixture();
  const raw = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, "utf8");
  const sourcePath = path.join(input, "source.flow.json");
  const metaPath = path.join(input, "source.flow.meta.json");
  fs.writeFileSync(sourcePath, raw, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: "live-147",
    sourceHost: "lk-primary-147",
    sourceUser: "root",
    sourcePort: "22",
    remoteFlowPath: "/root/.node-red/flows.json",
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: sha256(raw),
    nodeCount: flow.length,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(metaPath, 0o600);
  return { root, workspace, sourcePath };
}

test("Viva URL matching accepts owned hosts and rejects lookalikes", () => {
  assert.equal(isVivaHostname("api.vivacrm.ru"), true);
  assert.equal(isVivaHostname("helpdesk.vivacrm.ru."), true);
  assert.equal(isVivaUrl("https://kc.vivacrm.ru/token"), true);
  assert.equal(isVivaUrl("https://api.vivacrm.ru.evil.example/token"), false);
  assert.equal(isVivaUrl("https://padlhub.su/lk"), false);
});

test("server fetch adds the stable User-Agent only for Viva and preserves headers", async () => {
  const calls = [];
  const vivaFetch = createVivaFetch(async (input, init) => {
    calls.push({ input, init });
    return { ok: true };
  });
  await vivaFetch("https://api.vivacrm.ru/api/v1/exercises", {
    method: "GET",
    headers: { Authorization: "Bearer test", Accept: "application/json" },
  });
  await vivaFetch("https://padlhub.su/lk/games", {
    headers: { Accept: "application/json" },
  });

  assert.equal(calls[0].init.headers.get("user-agent"), PADLHUB_VIVA_USER_AGENT);
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer test");
  assert.equal(calls[0].init.headers.get("accept"), "application/json");
  assert.equal(new Headers(calls[1].init.headers).has("user-agent"), false);
});

test("User-Agent validation and conflicting values fail closed", () => {
  assert.equal(validateVivaUserAgent(), PADLHUB_VIVA_USER_AGENT);
  assert.throws(() => validateVivaUserAgent("PadlHub\r\nInjected: value"), /visible ASCII/);
  const vivaFetch = createVivaFetch(() => ({ ok: true }));
  assert.throws(
    () => vivaFetch("https://api.vivacrm.ru/api", { headers: { "User-Agent": "Other/1.0" } }),
    /Conflicting Viva User-Agent/,
  );
});

test("Node-RED discovery follows bounded upstream evidence and ignores labels/lookalikes", () => {
  const targets = discoverVivaHttpRequestNodes(flowFixture());
  assert.deepEqual(
    targets.map((target) => target.id).sort(),
    ["request-helpdesk", "request-token", "request-viva"],
  );
  assert.equal(targets.find((target) => target.id === "request-helpdesk").evidence.depth, 2);
  assert.deepEqual(
    targets.find((target) => target.id === "request-viva").nonVivaLiteralHosts,
    ["padlhub.su"],
  );
  assert.equal(targets.some((target) => target.id === "request-local"), false);
  assert.equal(targets.some((target) => target.id === "request-lookalike"), false);
});

test("Node-RED patch changes only configured headers and is idempotent", () => {
  const flow = flowFixture();
  const before = structuredClone(flow);
  const result = applyVivaUserAgent(flow);
  assert.equal(result.targets.length, 3);
  assert.equal(result.changedNodes.length, 3);
  assert(result.changedNodes.every((change) => (
    change.changedFields.length === 1 && change.changedFields[0] === "headers"
  )));

  const vivaNode = flow.find((node) => node.id === "request-viva");
  assert.deepEqual(vivaNode.headers, [
    configuredHeader("Accept", "application/json"),
    NODE_RED_USER_AGENT_HEADER,
  ]);
  assert.deepEqual(
    flow.find((node) => node.id === "request-local"),
    before.find((node) => node.id === "request-local"),
  );
  assert.deepEqual(
    flow.map((node) => ({ id: node.id, wires: node.wires ?? null })),
    before.map((node) => ({ id: node.id, wires: node.wires ?? null })),
  );

  const second = applyVivaUserAgent(flow);
  assert.equal(second.changedNodes.length, 0);
  assert.equal(second.alreadyCompliantNodeCount, 3);
});

test("Node-RED patch rejects a conflicting configured User-Agent", () => {
  const flow = flowFixture();
  flow.find((node) => node.id === "request-viva").headers.push(
    configuredHeader("User-Agent", "Other/1.0"),
  );
  assert.throws(() => applyVivaUserAgent(flow), /conflicting User-Agent/);
});

test("verified live-workspace publication is private and redacted", () => {
  const built = workspaceFixture();
  const publication = path.join(built.root, "publication");
  const output = path.join(publication, "candidate.json");
  const reportPath = path.join(publication, "report.json");
  const report = publishVivaUserAgentCandidate({
    workspace: built.workspace,
    output,
    report: reportPath,
  });

  assert.equal(report.discoveredNodeCount, 3);
  assert.equal(report.changedNodeCount, 3);
  assert.equal(report.sharedDestinationNodeCount, 1);
  assert.equal(report.nameOnlyReviewNodeCount, 1);
  assert.deepEqual(report.nameOnlyReviewNodes.map((node) => node.id), ["request-local"]);
  assert.equal(report.userAgent, PADLHUB_VIVA_USER_AGENT);
  assert.equal(fs.statSync(publication).mode & 0o777, 0o700);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600);
  const candidate = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(
    candidate.find((node) => node.id === "request-token").headers[0].valueValue,
    PADLHUB_VIVA_USER_AGENT,
  );
  assert.equal(JSON.stringify(report).includes("Bearer test"), false);
});

test("publication rejects a source changed after live-pull metadata", () => {
  const built = workspaceFixture();
  fs.appendFileSync(built.sourcePath, "\n");
  assert.throws(() => publishVivaUserAgentCandidate({
    workspace: built.workspace,
    output: path.join(built.root, "tampered", "candidate.json"),
    report: path.join(built.root, "tampered", "report.json"),
  }), /hash does not match/);
});

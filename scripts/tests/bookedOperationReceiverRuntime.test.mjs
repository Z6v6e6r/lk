import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { receiverFunctionSource } from "../patch_nodered_booked_operation_receiver_flow.mjs";

// Opt-in compatibility evidence on the exact production Node-RED version.
// The runtime tree is never part of the repository and nothing is installed:
// run with NODERED_RUNTIME_ROOT pointing at an existing Node-RED 4.0.9 install.
const runtimeRoot = process.env.NODERED_RUNTIME_ROOT;
const ADMIT_PATH = "/lk/integrations/v1/booked-operation-admissions";
const READ_PREFIX = "/lk/integrations/v1/booked-operations/";
const ISSUER = "https://lk2.runtime.test/issuer";
const AUDIENCE = "lk1-booked-operation";
const KEY_ID = "lk2-runtime-key";
const DELEGATION_TYPE = "phub-subscription-runtime-actor-delegation+jwt";

const b64url = (value) => Buffer.from(value).toString("base64url");
const sha256Hex = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const now = () => Math.floor(Date.now() / 1000);

test(
  "Node-RED 4.0.9 loads the builtin crypto module and enforces the delegation matrix",
  { skip: !runtimeRoot, timeout: 60_000 },
  async () => {
    const requireFromRuntime = createRequire(path.join(runtimeRoot, "package.json"));
    assert.equal(requireFromRuntime("node-red/package.json").version, "4.0.9");
    const RED = requireFromRuntime("node-red");
    const express = requireFromRuntime("express");

    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const { privateKey: otherPrivateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const mappingId = crypto.randomUUID();
    const targetMappingId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const correlationId = "runtime-correlation-0001";
    const body = { action: "JOIN_GAME", paymentIntent: "USE_SUBSCRIPTION", target: { id: targetId, expectedRevision: 3 } };
    const requestSha = "sha256:" + sha256Hex(
      "booked-operation-admission:v1\0" + JSON.stringify({
        action: "JOIN_GAME",
        target: { id: body.target.id, expectedRevision: body.target.expectedRevision },
        paymentIntent: "USE_SUBSCRIPTION",
      }),
    );
    const sign = (claims, key) => {
      const header = b64url(JSON.stringify({ alg: "RS256", typ: DELEGATION_TYPE, kid: KEY_ID }));
      const payload = b64url(JSON.stringify(claims));
      const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
      return `${header}.${payload}.${b64url(signature)}`;
    };
    const common = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: userId,
      iat: now() - 1,
      nbf: now() - 1,
      exp: now() + 30,
      jti: crypto.randomUUID(),
    };
    const admissionToken = sign({
      ...common,
      contract_version: 1,
      scope: "subscription-runtime.booked-operation.admit",
      caller: "lk2-api",
      method: "POST",
      path: ADMIT_PATH,
      operation_id: operationId,
      tenant_id: tenantId,
      tenant_key: "iSkq6G",
      sid: sessionId,
      provider: "VIVA",
      provider_client_id: "viva-runtime-client",
      provider_mapping_id: mappingId,
      correlation_id: correlationId,
      request_sha256: requestSha,
      idempotency_key_sha256: "sha256:" + sha256Hex("runtime-idempotency-key"),
      target_id: targetId,
      expected_revision: 3,
      target_mapping_id: targetMappingId,
      provider_exercise_id: "viva-runtime-exercise",
      target_version: "1",
      target_starts_at: "2026-10-25T09:00:00.000Z",
      target_duration_minutes: 90,
      target_capacity: 4,
      target_admissible: true,
    }, privateKey);
    const readToken = sign({
      ...common,
      contract_version: 1,
      scope: "subscription-runtime.booked-operation.read",
      caller: "lk2-api",
      method: "GET",
      path: READ_PREFIX + operationId,
      operation_id: operationId,
      tenant_id: tenantId,
      tenant_key: "iSkq6G",
      sid: sessionId,
      provider: "VIVA",
      provider_client_id: "viva-runtime-client",
      provider_mapping_id: mappingId,
      correlation_id: correlationId,
    }, privateKey);

    process.env.LK1_BOOKED_OPERATION_RECEIVER_ENABLED = "true";
    process.env.LK2_BOOKED_OPERATION_DELEGATION_ISSUER = ISSUER;
    process.env.LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE = AUDIENCE;
    process.env.LK2_BOOKED_OPERATION_DELEGATION_KEY_ID = KEY_ID;
    process.env.LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM = publicKey;

    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "booked-op-runtime-"));
    const app = express();
    const server = http.createServer(app);
    RED.init(server, {
      userDir,
      flowFile: "flows.json",
      httpAdminRoot: "/admin",
      httpNodeRoot: "/",
      disableEditor: true,
      logging: { console: { level: "off" } },
    });
    app.use("/admin", RED.httpAdmin);
    app.use("/", RED.httpNode);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await RED.start();
    const base = `http://127.0.0.1:${server.address().port}`;
    const flow = [
      { id: "tab", type: "tab", label: "booked-op-runtime" },
      { id: "post-in", type: "http in", z: "tab", url: ADMIT_PATH, method: "post", wires: [["post-verify"]] },
      {
        id: "post-verify",
        type: "function",
        z: "tab",
        outputs: 2,
        libs: [{ var: "nodeCrypto", module: "crypto" }],
        func: receiverFunctionSource("admission_verify"),
        wires: [["collector"], ["respond"]],
      },
      {
        id: "get-in",
        type: "http in",
        z: "tab",
        url: `${READ_PREFIX}:operationId`,
        method: "get",
        wires: [["get-verify"]],
      },
      {
        id: "get-verify",
        type: "function",
        z: "tab",
        outputs: 2,
        libs: [{ var: "nodeCrypto", module: "crypto" }],
        func: receiverFunctionSource("read_verify"),
        wires: [["collector"], ["respond"]],
      },
      {
        id: "collector",
        type: "function",
        z: "tab",
        outputs: 1,
        func: "msg.statusCode = 202; msg.payload = { ok: true, mode: msg._bookedOperation.mode, operationId: msg._bookedOperation.operationId }; return [msg];",
        wires: [["respond"]],
      },
      {
        id: "respond",
        type: "function",
        z: "tab",
        outputs: 1,
        func: receiverFunctionSource("response"),
        wires: [["http-out"]],
      },
      { id: "http-out", type: "http response", z: "tab", wires: [] },
    ];
    try {
      const deploy = await fetch(`${base}/admin/flows`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Node-RED-API-Version": "v2",
          "Node-RED-Deployment-Type": "full",
        },
        body: JSON.stringify({ flows: flow }),
      });
      assert.equal(deploy.status, 200, await deploy.text());

      const post = (token, requestBody = body) => fetch(`${base}${ADMIT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Correlation-ID": correlationId,
          ...(token ? { "X-Subscription-Actor-Delegation": token } : {}),
        },
        body: JSON.stringify(requestBody),
      });
      const accepted = await post(admissionToken);
      assert.equal(accepted.status, 202);
      assert.deepEqual(await accepted.json(), { ok: true, mode: "admit", operationId });

      const missing = await post(null);
      assert.equal(missing.status, 401);

      const wrongKey = await post(sign(JSON.parse(Buffer.from(
        admissionToken.split(".")[1],
        "base64url",
      ).toString("utf8")), otherPrivateKey));
      assert.equal(wrongKey.status, 401);

      const replayedBody = await post(admissionToken, {
        ...body,
        target: { ...body.target, expectedRevision: 4 },
      });
      assert.equal(replayedBody.status, 403);

      const read = await fetch(`${base}${READ_PREFIX}${operationId}`, {
        headers: {
          "X-Correlation-ID": correlationId,
          "X-Subscription-Actor-Delegation": readToken,
        },
      });
      assert.equal(read.status, 202);
      assert.deepEqual(await read.json(), { ok: true, mode: "read", operationId });

      const admissionTokenOnRead = await fetch(`${base}${READ_PREFIX}${operationId}`, {
        headers: {
          "X-Correlation-ID": correlationId,
          "X-Subscription-Actor-Delegation": admissionToken,
        },
      });
      assert.equal(admissionTokenOnRead.status, 401);
      assert.deepEqual(
        Object.keys(await admissionTokenOnRead.json()).sort(),
        ["code", "error"],
      );
    } finally {
      await RED.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(userDir, { recursive: true, force: true });
    }
  },
);

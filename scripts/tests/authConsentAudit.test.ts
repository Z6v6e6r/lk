import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const workspaceRoot = process.cwd();
const nodeDir = path.join(workspaceRoot, "scripts/nodered_auth_consent_nodes");

function runFunctionNode(fileName: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(path.join(nodeDir, fileName), "utf8");
  const execute = new Function("msg", source);
  return execute(msg);
}

function validConsentBody() {
  return {
    schemaVersion: 1,
    documentSetVersion: "2026-07-14",
    acceptedAtClient: "2026-07-14T10:15:00.000Z",
    authMethod: "vkid",
    documents: [
      {
        id: "public-offer",
        version: "2026-07-14",
        url: "https://padlhub.ru/docs",
        accepted: true,
      },
      {
        id: "personal-data-policy",
        version: "2026-07-14",
        url: "https://padlhub.ru/politica",
        accepted: true,
      },
    ],
  };
}

function unsignedJwt(payload: Record<string, unknown>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

test("consent prepare rejects unauthenticated and non-canonical requests", () => {
  const missingAuth = runFunctionNode("fn_auth_consent_prepare.js", {
    payload: validConsentBody(),
    req: { headers: {} },
  });
  assert.equal(missingAuth[1].statusCode, 401);
  assert.equal(missingAuth[1].payload.code, "AUTH_TOKEN_REQUIRED");

  const wrongVersionBody = validConsentBody();
  wrongVersionBody.documentSetVersion = "client-controlled-version";
  const wrongVersion = runFunctionNode("fn_auth_consent_prepare.js", {
    payload: wrongVersionBody,
    req: { headers: { authorization: "Bearer signed-token" } },
  });
  assert.equal(wrongVersion[1].statusCode, 400);
  assert.equal(wrongVersion[1].payload.code, "CONSENT_VERSION_INVALID");
});

test("consent prepare forwards only bearer to the fixed Keycloak userinfo endpoint", () => {
  const body = { ...validConsentBody(), subject: "attacker-subject", tenantKey: "attacker-tenant" };
  const token = unsignedJwt({ azp: "widget", tenant_key: "iSkq6G" });
  const result = runFunctionNode("fn_auth_consent_prepare.js", {
    payload: body,
    req: { headers: { authorization: `Bearer ${token}` } },
  });
  const prepared = result[0];
  assert.equal(result[1], null);
  assert.equal(prepared.method, "GET");
  assert.equal(
    prepared.url,
    "https://kc.vivacrm.ru/realms/clients/protocol/openid-connect/userinfo",
  );
  assert.equal(prepared.headers.Authorization, `Bearer ${token}`);
  assert.equal(prepared._authConsent.subject, undefined);
  assert.equal(prepared._authConsent.tenantKey, undefined);
  assert.equal(prepared._authConsent.verifiedTokenContext.authorizedParty, "widget");
  assert.equal(prepared._authConsent.verifiedTokenContext.tenantKey, "iSkq6G");
});

test("verified userinfo builds an immutable idempotent Mongo upsert", () => {
  const context = {
    documentSetVersion: "2026-07-14",
    acceptedAtClient: "2026-07-14T10:15:00.000Z",
    authMethodReported: "vkid",
    documents: validConsentBody().documents.map(({ accepted: _accepted, ...document }) => document),
    verifiedTokenContext: {
      authorizedParty: "widget",
      audience: ["account", "widget"],
      tenantKey: "iSkq6G",
    },
  };
  const build = () => runFunctionNode("fn_auth_consent_build_upsert.js", {
    statusCode: 200,
    payload: {
      sub: "verified-subject",
      phone_number: "+7 999 123-45-67",
    },
    _authConsent: structuredClone(context),
    req: { headers: { "user-agent": "test" }, ip: "127.0.0.1" },
  });

  const first = build()[0];
  const second = build()[0];
  const [query, update, options] = first.payload;
  assert.equal(first._authConsent.tenantKey, "iSkq6G");
  assert.equal(first._authConsent.subject, "verified-subject");
  assert.equal(query._id, second.payload[0]._id);
  assert.match(query._id, /^auth-consent:iSkq6G:verified-subject:2026-07-14$/);
  assert.equal(update.$setOnInsert.subject, "verified-subject");
  assert.equal(update.$setOnInsert.identity.phone, "79991234567");
  assert.equal(update.$setOnInsert.documentSetVersion, "2026-07-14");
  assert.ok(update.$setOnInsert.acceptedAt instanceof Date);
  assert.ok(update.$setOnInsert.acceptedAtClient instanceof Date);
  assert.deepEqual(options, { upsert: true });
  assert.equal(update.$set, undefined);
});

test("verified bearer must belong to the widget client and PadlHub tenant", () => {
  const base = {
    statusCode: 200,
    payload: { sub: "verified-subject" },
    _authConsent: {
      documentSetVersion: "2026-07-14",
      documents: [],
      verifiedTokenContext: {
        authorizedParty: "other-client",
        audience: ["widget"],
        tenantKey: "iSkq6G",
      },
    },
  };
  const wrongClient = runFunctionNode("fn_auth_consent_build_upsert.js", structuredClone(base));
  assert.equal(wrongClient[1].statusCode, 403);
  assert.equal(wrongClient[1].payload.code, "AUTH_CLIENT_MISMATCH");

  const wrongTenantMessage = structuredClone(base);
  wrongTenantMessage._authConsent.verifiedTokenContext.authorizedParty = "widget";
  wrongTenantMessage._authConsent.verifiedTokenContext.tenantKey = "other-tenant";
  const wrongTenant = runFunctionNode("fn_auth_consent_build_upsert.js", wrongTenantMessage);
  assert.equal(wrongTenant[1].statusCode, 403);
  assert.equal(wrongTenant[1].payload.code, "AUTH_TENANT_MISMATCH");
});

test("consent id encoding is lossless for distinct subjects", () => {
  const buildId = (subject: string) => runFunctionNode("fn_auth_consent_build_upsert.js", {
    statusCode: 200,
    payload: { sub: subject },
    _authConsent: {
      documentSetVersion: "2026-07-14",
      documents: [],
      verifiedTokenContext: { authorizedParty: "widget", tenantKey: "iSkq6G" },
    },
  })[0].payload[0]._id;
  assert.notEqual(buildId("subject/value"), buildId("subject_2Fvalue"));
});

test("userinfo failure never reaches Mongo", () => {
  const result = runFunctionNode("fn_auth_consent_build_upsert.js", {
    statusCode: 401,
    payload: { sub: "untrusted-response" },
    _authConsent: { documentSetVersion: "2026-07-14", documents: [] },
  });
  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 401);
  assert.equal(result[1].payload.code, "AUTH_TOKEN_INVALID");

  const unavailable = runFunctionNode("fn_auth_consent_build_upsert.js", {
    statusCode: 0,
    error: { message: "connect timeout" },
    payload: {},
    _authConsent: { documentSetVersion: "2026-07-14", documents: [] },
  });
  assert.equal(unavailable[0], null);
  assert.equal(unavailable[1].statusCode, 503);
  assert.equal(unavailable[1].payload.code, "AUTH_SERVICE_UNAVAILABLE");
});

test("consent response distinguishes first insert from idempotent replay", () => {
  const created = runFunctionNode("fn_auth_consent_response.js", {
    payload: { upsertedCount: 1, upsertedId: "consent-id" },
    _authConsent: { id: "consent-id", documentSetVersion: "2026-07-14" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.payload.created, true);

  const replay = runFunctionNode("fn_auth_consent_response.js", {
    payload: { matchedCount: 1, modifiedCount: 1 },
    _authConsent: { id: "consent-id", documentSetVersion: "2026-07-14" },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.created, false);
});

test("patch script is idempotent and reuses the Analytics Mongo client", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-consent-flow-"));
  const sourcePath = path.join(tempDir, "source.flow.json");
  const importPath = path.join(tempDir, "auth-consents.import.json");
  const analyticsTabId = "analytics-tab";
  const mongoClientId = "existing-mongo-client";
  fs.writeFileSync(sourcePath, JSON.stringify([
    { id: analyticsTabId, type: "tab", label: "LK Analytics", disabled: false },
    {
      id: "analytics-in",
      type: "http in",
      z: analyticsTabId,
      method: "post",
      url: "/lk/analytics/events",
      wires: [["analytics-mongo"]],
    },
    {
      id: "analytics-mongo",
      type: "mongodb4",
      z: analyticsTabId,
      clientNode: mongoClientId,
      collection: "events",
      operation: "insertOne",
      wires: [[]],
    },
    { id: mongoClientId, type: "mongodb4-client", name: "existing" },
  ]));

  try {
    for (let index = 0; index < 2; index += 1) {
      execFileSync(
        process.execPath,
        ["scripts/patch_nodered_auth_consents_flow.mjs", sourcePath, importPath],
        { cwd: workspaceRoot, stdio: "pipe" },
      );
    }
    const patched = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const postRoutes = patched.filter((node: Record<string, unknown>) => (
      node.type === "http in"
      && node.method === "post"
      && node.url === "/lk/analytics/auth-consents"
    ));
    const optionsRoutes = patched.filter((node: Record<string, unknown>) => (
      node.type === "http in"
      && node.method === "options"
      && node.url === "/lk/analytics/auth-consents"
    ));
    const consentMongo = patched.find((node: Record<string, unknown>) => (
      node.type === "mongodb4" && node.collection === "lk_auth_consents"
    ));
    assert.equal(postRoutes.length, 1);
    assert.equal(optionsRoutes.length, 1);
    assert.equal(consentMongo.clientNode, mongoClientId);
    assert.ok(fs.existsSync(importPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("auth consent patch remains guarded while broad repository sync is not exposed", () => {
  const patchSource = fs.readFileSync("scripts/patch_nodered_auth_consents_flow.mjs", "utf8");
  const pullSource = fs.readFileSync("scripts/pull_nodered_source_from_147.sh", "utf8");
  const verifySource = fs.readFileSync("scripts/verify_nodered_source_origin.mjs", "utf8");
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const syncCommand = String(packageJson.scripts["nodered:modular:sync-games-source"] || "");
  const auditCommand = String(packageJson.scripts["nodered:modular:audit-147"] || "");
  assert.match(patchSource, /usesDefaultSource = sourcePath === defaultSourcePath/);
  assert.match(patchSource, /maxSourceAgeMs = 30 \* 60 \* 1000/);
  assert.match(patchSource, /sourceHost === "lk-primary-147"/);
  assert.match(patchSource, /sourceSha256 === meta\.sourceSha256/);
  assert.match(pullSource, /sourceSha256/);
  assert.match(verifySource, /source hash does not match live-pull metadata/);
  assert.equal(syncCommand, "");
  assert.equal(auditCommand, "bash ./scripts/prepare_nodered_live_workspace.sh");
});

test("frontend stages before auth and flushes after token acquisition", () => {
  const formSource = fs.readFileSync("src/components/auth/VivaAuthForm.tsx", "utf8");
  const providerSource = fs.readFileSync("src/context/VivaAuthProvider.tsx", "utf8");
  const clientSource = fs.readFileSync("src/utils/authConsents.ts", "utf8");

  assert.match(formSource, /stageAuthConsents\(\{[\s\S]*bindingType: "sms-phone"[\s\S]*sendCode/);
  assert.match(providerSource, /startVivaOAuthRedirect\([\s\S]*bindingType: "oauth-state"/);
  assert.match(providerSource, /applyTokenState\(data\);[\s\S]*syncPendingAuthConsents\(\{[\s\S]*bindingType: "oauth-state"/);
  assert.match(providerSource, /applyTokenState\(data, phoneNumber\);[\s\S]*syncPendingAuthConsents\(\{[\s\S]*bindingType: "sms-phone"/);
  assert.match(clientSource, /AUTH_CONSENT_DOCUMENT_SET_VERSION = "2026-07-14"/);
  assert.match(clientSource, /removePendingAuthConsent\(pending\.attemptFingerprint\)/);
  assert.match(clientSource, /storageKeyForAttempt/);
  assert.match(clientSource, /attemptFingerprint/);
  assert.match(clientSource, /subjectFingerprint && pending\.subjectFingerprint !== subjectFingerprint/);
  assert.match(clientSource, /crypto\.subtle\.digest/);
  assert.match(providerSource, /addEventListener\("online", retryNow\)/);
});

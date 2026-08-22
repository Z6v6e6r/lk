import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  sanitizeHarFile,
  sanitizeHarText,
} from "../sanitize_viva_har.mjs";

const TEST_JWT = [
  "eyJ0123456789AB",
  "eyJ0123456789CD",
  "signature0123456789",
].join(".");

const createEntry = ({
  url,
  method = "POST",
  requestText = "{}",
  responseText = "{}",
  responseEncoding,
} = {}) => ({
  startedDateTime: "2026-08-11T10:00:00.000Z",
  time: 25,
  request: {
    method,
    url,
    httpVersion: "HTTP/2",
    headers: [
      { name: "Authorization", value: `Bearer ${TEST_JWT}` },
      { name: "Cookie", value: "session=private" },
      { name: "Content-Type", value: "application/json" },
      { name: "User-Agent", value: "private-browser-fingerprint" },
    ],
    queryString: [],
    cookies: [{ name: "session", value: "private" }],
    postData: {
      mimeType: "application/json; boundary=private-boundary",
      text: requestText,
    },
    headersSize: 1,
    bodySize: 2,
  },
  response: {
    status: 200,
    statusText: "private-status-detail",
    httpVersion: "HTTP/2",
    headers: [{ name: "Set-Cookie", value: "session=private" }],
    cookies: [{ name: "session", value: "private" }],
    content: {
      size: 10,
      mimeType: "application/json",
      text: responseText,
      ...(responseEncoding ? { encoding: responseEncoding } : {}),
    },
    redirectURL: "",
    headersSize: 1,
    bodySize: 2,
  },
  cache: {},
  timings: { send: 1, wait: 20, receive: 4, privateNote: "private-timing-detail" },
  serverIPAddress: "10.0.0.1",
  connection: "123",
});

const createFixture = () => {
  const compactPhone = ["7912", "345", "6789"].join("");
  const rawPhone = `+7 (${compactPhone.slice(1, 4)}) ${compactPhone.slice(4, 7)}-${compactPhone.slice(7, 9)}-${compactPhone.slice(9)}`;
  const rawEmail = ["tester", "example.com"].join("@");
  const rawPan = ["4111", "1111", "1111", "1111"].join("");
  const rawUuid = "3e23c6af-a71f-4a9c-94da-ef167d67ecaa";
  const source = JSON.stringify({
    log: {
      version: "1.2",
      entries: [
        createEntry({
          url: `https://api.vivacrm.ru/end-user/api/v2/iSkq6G/bookings/${rawUuid}?phone=${compactPhone}&size=100`,
          requestText: JSON.stringify({
            exerciseId: rawUuid,
            clientPhone: rawPhone,
            email: rawEmail,
            comment: { value: "private-note-opaque" },
            birthDate: "1990-01-01",
            metadata: { value: rawPan, numericValue: Number(rawPan) },
            paymentType: "SUBSCRIPTION",
          }),
          responseText: JSON.stringify({
            id: rawUuid,
            status: "ACTIVE",
            refundMethod: "SERVICE",
            phone: rawPhone,
          }),
        }),
        createEntry({
          url: "https://mc.yandex.ru/watch/123",
          method: "GET",
        }),
        createEntry({
          url: "https://api.vivacrm.ru/api/v1/authorization-tickets/eu",
        }),
      ],
    },
  });
  return {
    compactPhone,
    rawEmail,
    rawPan,
    rawPhone,
    rawUuid,
    source,
  };
};

const sanitizeBookingFixture = (source) => sanitizeHarText(source, {
  allowedHosts: ["api.vivacrm.ru", "padlhub.su"],
  allowedPathPrefixes: ["/end-user/api/v2/{tenant}/bookings"],
  caseId: "GHAR-BKG-JOIN-060",
});

test("filters hosts and paths while preserving contract enums and stable aliases", () => {
  const fixture = createFixture();
  const result = sanitizeBookingFixture(fixture.source);

  assert.equal(result.manifest.sourceEntryCount, 3);
  assert.equal(result.manifest.retainedEntryCount, 1);
  assert.equal(result.manifest.removedEntryCount, 2);
  assert.equal(result.manifest.evidenceStatus, "SANITIZED");
  assert.equal(result.manifest.securityChecks.manualReviewRequired, true);
  assert.match(result.manifest.endpoints[0].pathTemplate, /\/{tenant}\//);

  for (const secret of [
    fixture.rawPhone,
    fixture.compactPhone,
    fixture.rawEmail,
    fixture.rawPan,
    fixture.rawUuid,
    "session=private",
    "private-browser-fingerprint",
    "private-boundary",
    "private-status-detail",
    "private-note-opaque",
    "private-timing-detail",
    "1990-01-01",
  ]) {
    assert.equal(result.sanitizedText.includes(secret), false, `secret leaked: ${secret}`);
  }
  assert.equal(result.sanitizedText.includes("User-Agent"), false);

  const entry = result.sanitizedHar.log.entries[0];
  const requestBody = JSON.parse(entry.request.postData.text);
  const responseBody = JSON.parse(entry.response.content.text);
  assert.equal(requestBody.paymentType, "SUBSCRIPTION");
  assert.equal(responseBody.refundMethod, "SERVICE");
  assert.equal(responseBody.status, "ACTIVE");

  const url = new URL(entry.request.url);
  const urlAlias = url.pathname.split("/").at(-1);
  assert.match(urlAlias, /^uuid-\d{3}$/);
  assert.equal(urlAlias, requestBody.exerciseId);
  assert.equal(requestBody.exerciseId, responseBody.id);
  assert.equal(url.searchParams.get("size"), "100");
  assert.match(url.searchParams.get("phone"), /^phone-\d{3}$/);
});

test("rejects invalid HAR and a raw end-user tenant path", () => {
  const { source } = createFixture();
  assert.throws(() => sanitizeHarText("{}", {
    allowedHosts: ["api.vivacrm.ru"],
    allowedPathPrefixes: ["/api/v1/transactions"],
    caseId: "GHAR-PUR-001",
  }), /valid HAR/);
  assert.throws(() => sanitizeHarText(source, {
    allowedHosts: ["api.vivacrm.ru"],
    allowedPathPrefixes: ["/end-user/api/v2/iSkq6G/bookings"],
    caseId: "GHAR-BKG-JOIN-060",
  }), /\{tenant\}/);
});

test("drops encoded and non-JSON bodies", () => {
  const compactPhone = ["7912", "345", "6789"].join("");
  const source = JSON.stringify({
    log: {
      version: "1.2",
      entries: [createEntry({
        url: "https://api.vivacrm.ru/api/v1/transactions",
        requestText: `phone=${compactPhone}&private=true`,
        responseText: "binary-private-content",
        responseEncoding: "base64",
      })],
    },
  });
  const result = sanitizeHarText(source, {
    allowedHosts: ["api.vivacrm.ru"],
    allowedPathPrefixes: ["/api/v1/transactions"],
    caseId: "GHAR-PUR-001",
  });
  assert.equal(result.sanitizedText.includes(compactPhone), false);
  assert.equal(result.sanitizedText.includes("binary-private-content"), false);
  assert.match(result.sanitizedText, /NON_JSON_BODY_REDACTED/);
});

test("rounds browser timing precision that can look like a phone token", () => {
  const entry = createEntry({
    url: "https://api.vivacrm.ru/api/v1/exercises/types",
    method: "GET",
  });
  entry.timings.wait = 777.12345678901;
  const source = JSON.stringify({
    log: {
      version: "1.2",
      entries: [entry],
    },
  });

  const result = sanitizeHarText(source, {
    allowedHosts: ["api.vivacrm.ru"],
    allowedPathPrefixes: ["/api/v1/exercises/types"],
    caseId: "GHAR-MAP-TYPES",
  });

  assert.equal(result.sanitizedText.includes("71234567890"), false);
  assert.equal(result.sanitizedHar.log.entries[0].timings.wait, 777.123);
});

test("writes private files and refuses overwrite", () => {
  const { source } = createFixture();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "padlhub-har-sanitizer-"));
  try {
    const inputPath = path.join(tempRoot, "source.har");
    const outputPath = path.join(tempRoot, "sanitized.har");
    const manifestPath = path.join(tempRoot, "manifest.json");
    fs.writeFileSync(inputPath, source, { encoding: "utf8", mode: 0o600 });
    const options = {
      inputPath,
      outputPath,
      manifestPath,
      allowedHosts: ["api.vivacrm.ru"],
      allowedPathPrefixes: ["/end-user/api/v2/{tenant}/bookings"],
      caseId: "GHAR-BKG-JOIN-060",
    };
    const manifest = sanitizeHarFile(options);
    assert.equal(manifest.retainedEntryCount, 1);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
    assert.throws(() => sanitizeHarFile(options), /already exists/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

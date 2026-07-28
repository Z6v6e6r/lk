#!/usr/bin/env node

/**
 * Builds a narrowly-scoped Node-RED containment patch for the live
 * /lk/tournaments/participants read route. It intentionally changes no
 * tournament write, cancellation, payment, or result node.
 *
 * Usage:
 *   node scripts/patch_live_tournament_participants_containment.mjs input.json output.json
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  throw new Error("Usage: node scripts/patch_live_tournament_participants_containment.mjs input.json output.json");
}

const EXPECTED_SOURCE_SHA256 = "ae33d314f692d6e79539fe67fdab8408128fb9e8a85cea6ca9a316c8e3ff61d0";
const TAB_ID = "f9575c8726e29196";

const ids = {
  httpIn: "e0836350a9474a78",
  validate: "4970937254c10761",
  bookingsRequest: "fbbb248557014e63",
  normalize: "efa2b09c651dac1f",
  split: "517cb87b7425ef66",
  clientRequest: "21d3e90986ed5b82",
  clientHttp: "8f038c84aa896ec2",
  attachRating: "0c63087697cb16c0",
  join: "22d45839d507e03b",
  response: "afef710ac9f58b69",
  cacheGate: "lk_tournament_participants_cache_gate_20260719",
  terminal: "lk_tournament_participants_terminal_20260719",
  upstreamError: "lk_tournament_participants_upstream_error_20260719",
  clientQueue: "lk_tournament_participants_client_queue_20260719",
  clientRelease: "lk_tournament_participants_client_release_20260719",
};

const source = await readFile(inputPath);
const sourceSha256 = createHash("sha256").update(source).digest("hex");

if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {
  throw new Error(
    `Refusing to patch an unexpected flow snapshot: got ${sourceSha256}, expected ${EXPECTED_SOURCE_SHA256}. Pull a fresh flow and review the diff first.`,
  );
}

const flow = JSON.parse(source);
if (!Array.isArray(flow)) throw new Error("Node-RED flow must be an array");

const byId = new Map(flow.map((node) => [node.id, node]));
const requireNode = (id, type, name) => {
  const node = byId.get(id);
  if (!node || node.type !== type || node.z !== TAB_ID) {
    throw new Error(`Expected ${name} (${id}) was not found in LK Tournaments`);
  }
  return node;
};
const setWires = (node, wires) => {
  node.wires = wires;
};
const add = (node) => {
  if (byId.has(node.id)) throw new Error(`Patch node id already exists: ${node.id}`);
  flow.push(node);
  byId.set(node.id, node);
};

const httpIn = requireNode(ids.httpIn, "http in", "participants HTTP in");
const validate = requireNode(ids.validate, "function", "participants validator");
requireNode(ids.bookingsRequest, "http request", "Viva bookings request");
const normalize = requireNode(ids.normalize, "function", "bookings normalizer");
const clientRequest = requireNode(ids.clientRequest, "function", "client request builder");
requireNode(ids.clientHttp, "http request", "Viva client request");
const attachRating = requireNode(ids.attachRating, "function", "rating attachment");
const join = requireNode(ids.join, "join", "participants join");
requireNode(ids.response, "http response", "participants HTTP response");

if (httpIn.url !== "/lk/tournaments/participants") {
  throw new Error("The expected participants route changed; refusing to patch");
}

add({
  id: ids.cacheGate,
  type: "function",
  z: TAB_ID,
  name: "Participants cache + single-flight",
  func: `const CACHE_KEY = "lkTournamentParticipantResponseCacheV1";
const CACHE_TTL_MS = 5_000;
const STALE_TTL_MS = 60_000;
const CIRCUIT_KEY = "lkTournamentParticipantVivaCircuitV1";

const exerciseId = String(
  msg.req?.query?.exerciseId ||
  msg.req?.query?.tournamentId ||
  msg.payload?.exerciseId ||
  msg.payload?.tournamentId ||
  "",
).trim();
const requestedSize = Number(msg.req?.query?.size) || 100;
const size = Math.max(1, Math.min(Math.floor(requestedSize), 200));
const key = \`\${exerciseId}:\${size}\`;
const now = Date.now();
const state = flow.get(CACHE_KEY) || { entries: {}, inflight: {} };
const entry = state.entries[key];
const circuit = flow.get(CIRCUIT_KEY) || { failures: 0, openedUntil: 0 };

if (entry && now - entry.at <= CACHE_TTL_MS) {
  msg.statusCode = 200;
  msg.headers = { ...(msg.headers || {}), "x-lk-participants-cache": "hit" };
  msg.payload = entry.payload;
  return [null, msg];
}

if (circuit.openedUntil > now) {
  if (entry && now - entry.at <= STALE_TTL_MS) {
    msg.statusCode = 200;
    msg.headers = { ...(msg.headers || {}), "x-lk-participants-cache": "stale" };
    msg.payload = entry.payload;
  } else {
    msg.statusCode = 503;
    msg.payload = { error: "Participants temporarily unavailable" };
  }
  return [null, msg];
}

if (!exerciseId) {
  msg.statusCode = 400;
  msg.payload = { error: "exerciseId required" };
  return [null, msg];
}

if (state.inflight[key]) {
  state.inflight[key].waiters.push({ req: msg.req, res: msg.res, _msgid: msg._msgid });
  flow.set(CACHE_KEY, state);
  return null;
}

state.inflight[key] = { waiters: [], startedAt: now };
flow.set(CACHE_KEY, state);
msg.participantCacheKey = key;
msg.participantSize = size;
return [msg, null];`,
  outputs: 2,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 420,
  y: 1000,
  wires: [[ids.validate], [ids.terminal]],
});

add({
  id: ids.upstreamError,
  type: "function",
  z: TAB_ID,
  name: "Participants Viva circuit error",
  func: `const CIRCUIT_KEY = "lkTournamentParticipantVivaCircuitV1";
const current = flow.get(CIRCUIT_KEY) || { failures: 0, openedUntil: 0 };
const failures = current.failures + 1;
flow.set(CIRCUIT_KEY, {
  failures,
  openedUntil: failures >= 2 ? Date.now() + 15_000 : 0,
});

msg.statusCode = 502;
msg.payload = { error: "Participants temporarily unavailable" };
return msg;`,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1640,
  y: 1120,
  wires: [[ids.terminal]],
});

add({
  id: ids.clientQueue,
  type: "function",
  z: TAB_ID,
  name: "Viva client queue (max 3)",
  func: `const QUEUE_KEY = "lkTournamentParticipantClientQueueV1";
const MAX_CONCURRENCY = 3;
const MAX_QUEUE = 120;
const state = flow.get(QUEUE_KEY) || { active: 0, queue: [] };

if (state.queue.length >= MAX_QUEUE) {
  const participant = msg.participant || msg.payload;
  msg.payload = {
    ...participant,
    rating: participant?.client?.phone || null,
    ratingSource: participant?.client?.phone ? "phone" : "unavailable",
  };
  return [null, msg];
}

state.queue.push(msg);
const dispatch = [];
while (state.active < MAX_CONCURRENCY && state.queue.length) {
  const next = state.queue.shift();
  next._participantClientQueueSlot = true;
  state.active += 1;
  dispatch.push(next);
}
flow.set(QUEUE_KEY, state);
for (const next of dispatch) node.send([next, null]);
return null;`,
  outputs: 2,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 1770,
  y: 1000,
  wires: [[ids.clientHttp], [ids.join]],
});

add({
  id: ids.clientRelease,
  type: "function",
  z: TAB_ID,
  name: "Release Viva client queue slot",
  func: `const QUEUE_KEY = "lkTournamentParticipantClientQueueV1";
if (msg._participantClientQueueSlot) {
  const state = flow.get(QUEUE_KEY) || { active: 0, queue: [] };
  state.active = Math.max(0, state.active - 1);
  const dispatch = [];
  while (state.active < 3 && state.queue.length) {
    const next = state.queue.shift();
    next._participantClientQueueSlot = true;
    state.active += 1;
    dispatch.push(next);
  }
  flow.set(QUEUE_KEY, state);
  for (const next of dispatch) node.send([next, null]);
}
return msg;`,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 2300,
  y: 1000,
  wires: [[ids.join]],
});

add({
  id: ids.terminal,
  type: "function",
  z: TAB_ID,
  name: "Cache participants response + fanout",
  func: `const CACHE_KEY = "lkTournamentParticipantResponseCacheV1";
const state = flow.get(CACHE_KEY) || { entries: {}, inflight: {} };
const key = msg.participantCacheKey;
const statusCode = Number(msg.statusCode) || 200;

if (key && statusCode >= 200 && statusCode < 300 && Array.isArray(msg.payload)) {
  state.entries[key] = { at: Date.now(), payload: msg.payload };
  for (const [entryKey, entry] of Object.entries(state.entries)) {
    if (Date.now() - entry.at > 60_000) delete state.entries[entryKey];
  }
}

const waiters = key ? state.inflight[key]?.waiters || [] : [];
if (key) delete state.inflight[key];
flow.set(CACHE_KEY, state);

for (const waiter of [msg, ...waiters]) {
  waiter.statusCode = statusCode;
  waiter.payload = msg.payload;
  if (msg.headers) waiter.headers = msg.headers;
  node.send(waiter);
}
return null;`,
  outputs: 1,
  timeout: 0,
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x: 2600,
  y: 1000,
  wires: [[ids.response]],
});

setWires(httpIn, [[ids.cacheGate, "07131f07eb86f115"]]);
validate.func = `const exerciseId =
  msg.req?.query?.exerciseId ||
  msg.req?.query?.tournamentId ||
  msg.payload?.exerciseId ||
  msg.payload?.tournamentId;

if (!exerciseId) {
  msg.statusCode = 400;
  msg.payload = { error: "exerciseId required" };
  return [null, msg];
}

const token = global.get("vivacrm_access_token");
if (!token) {
  msg.statusCode = 401;
  msg.payload = { error: "VIVA_ADMIN_TOKEN missing" };
  return [null, msg];
}

msg.method = "GET";
const size = msg.participantSize || Math.max(1, Math.min(Number(msg.req?.query?.size) || 100, 200));
const safeExerciseId = encodeURIComponent(exerciseId);
msg.requestTimeout = 4500;
msg.url =
  \`https://api.vivacrm.ru/api/v1/exercises/\${safeExerciseId}/bookings\` +
  \`?showCancelled=false\` +
  \`&size=\${encodeURIComponent(String(size))}\` +
  \`&sort=visitConfirmed%2Casc\` +
  \`&sort=client.lastName%2Casc\`;
msg.headers = { Authorization: \`Bearer \${token}\` };
return [msg, null];`;
setWires(validate, [[ids.bookingsRequest, "91c4abd8f70de99a"], [ids.terminal]]);

normalize.func = `if (!(msg.statusCode >= 200 && msg.statusCode < 300)) {
  return [null, msg, null];
}

flow.set("lkTournamentParticipantVivaCircuitV1", { failures: 0, openedUntil: 0 });
const list = Array.isArray(msg.payload)
  ? msg.payload
  : (msg.payload?.content || []);

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return \`7\${digits}\`;
  if (digits.length === 11 && digits.startsWith("8")) return \`7\${digits.slice(1)}\`;
  return digits;
};

const isCancelled = (item) => {
  const status = String(item?.status || item?.state || "").trim().toLowerCase();
  return item?.isCancelled === true
    || item?.cancelled === true
    || item?.canceled === true
    || status === "cancelled"
    || status === "canceled"
    || status === "cancel";
};

const byKey = new Map();
list.forEach((item, index) => {
  const client = item?.client;
  const clientId = String(client?.id || "").trim();
  if (isCancelled(item) || !clientId) return;
  const phone = normalizePhone(client?.phone);
  const key = clientId ? \`client:\${clientId}\` : phone ? \`phone:\${phone}\` : \`booking:\${item?.id || index}\`;
  if (byKey.has(key)) return;
  byKey.set(key, {
    id: item.id,
    spot: item.spot,
    isCancelled: false,
    client: {
      id: clientId,
      firstName: client.firstName,
      lastName: client.lastName,
      middleName: client.middleName,
      photo: client.photo,
      phone: client.phone,
    },
  });
});

msg.payload = Array.from(byKey.values());
if (msg.payload.length === 0) return [null, null, msg];
return [msg, null, null];`;
normalize.outputs = 3;
setWires(normalize, [[ids.split], [ids.upstreamError], [ids.terminal]]);

clientRequest.func = `const CACHE_KEY = "lkTournamentParticipantClientRatingCacheV1";
const CACHE_TTL_MS = 10 * 60 * 1000;
const participant = msg.payload;
msg.participant = participant;
const clientId = String(participant?.client?.id || "").trim();
const cache = flow.get(CACHE_KEY) || {};
const cached = cache[clientId];

if (!clientId || (cached && Date.now() - cached.at <= CACHE_TTL_MS)) {
  msg.payload = {
    ...participant,
    rating: cached?.rating ?? participant?.client?.phone ?? null,
    ratingSource: cached?.ratingSource || (participant?.client?.phone ? "phone" : "unavailable"),
  };
  return [msg, null];
}

msg.method = "GET";
msg.requestTimeout = 2500;
msg.url = \`https://api.vivacrm.ru/api/v1/clients/\${encodeURIComponent(clientId)}\`;
msg.headers = { Authorization: \`Bearer \${global.get("vivacrm_access_token")}\` };
return [null, msg];`;
clientRequest.outputs = 2;
setWires(clientRequest, [[ids.join], [ids.clientQueue]]);

attachRating.func = `const LK_FIELD_ID = "f9790818-25fd-4b73-a781-79c02720727d";
const NUM_FIELD_ID = "eabfe27b-3f72-4496-9185-1a2ec6e6465e";
const client = msg.payload;
const participant = msg.participant;
const getField = (id) => client?.customFields?.find((field) => field.id === id)?.value?.[0];
const letter = getField(LK_FIELD_ID);
const numericRaw = getField(NUM_FIELD_ID);
const toFixed5 = (value) => {
  if (value == null) return null;
  const numeric = Number(String(value).replace(",", "."));
  return Number.isFinite(numeric) ? numeric.toFixed(5) : null;
};
const numeric = toFixed5(numericRaw);
const rating = numeric || letter || participant?.client?.phone || null;
const ratingSource = numeric ? "numeric" : letter ? "letter" : participant?.client?.phone ? "phone" : "unavailable";

if (msg.statusCode >= 200 && msg.statusCode < 300 && participant?.client?.id) {
  const CACHE_KEY = "lkTournamentParticipantClientRatingCacheV1";
  const cache = flow.get(CACHE_KEY) || {};
  cache[participant.client.id] = { at: Date.now(), rating, ratingSource };
  const entries = Object.entries(cache);
  if (entries.length > 500) {
    entries.sort(([, left], [, right]) => left.at - right.at).slice(0, entries.length - 500).forEach(([key]) => delete cache[key]);
  }
  flow.set(CACHE_KEY, cache);
}

msg.payload = { ...participant, rating, ratingSource };
return msg;`;
setWires(attachRating, [[ids.clientRelease, "0172ee848e9f2364"]]);
setWires(join, [[ids.terminal, "07de41d59cc86a90"]]);

await writeFile(outputPath, `${JSON.stringify(flow, null, 2)}\n`);
const importPath = outputPath.replace(/\.json$/u, ".import.json");
const importIds = new Set([
  ids.httpIn,
  ids.validate,
  ids.normalize,
  ids.clientRequest,
  ids.attachRating,
  ids.join,
  ids.cacheGate,
  ids.upstreamError,
  ids.clientQueue,
  ids.clientRelease,
  ids.terminal,
]);
await writeFile(importPath, `${JSON.stringify(flow.filter((node) => importIds.has(node.id)), null, 2)}\n`);
const outputSha256 = createHash("sha256").update(await readFile(outputPath)).digest("hex");
console.log(JSON.stringify({
  sourceSha256,
  outputSha256,
  importPath,
  importNodes: importIds.size,
  patchNodes: [ids.cacheGate, ids.upstreamError, ids.clientQueue, ids.clientRelease, ids.terminal],
}));

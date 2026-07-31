import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = process.env.NODERED_REPO_ROOT
  ? path.resolve(process.env.NODERED_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = process.env.NODERED_SOURCE_PATH
  ? path.resolve(process.env.NODERED_SOURCE_PATH)
  : path.join(rootDir, 'node-red/modular/source.flow.json');
const fnDir = path.join(rootDir, 'scripts/nodered_result_nodes');
const readFn = (name) => fs.readFileSync(path.join(fnDir, name), 'utf8');

const flow = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const byId = new Map(flow.map((node) => [node.id, node]));
const SOURCE_TAB_LABELS = ['LK Games', 'LK dops'];
const LEGACY_RESULT_TAB_LABEL = 'LK Games';
const SUBMIT_MONGO_MAX_TIME_MS = '5000';
const RESULT_MONGO_MAX_TIME_MS = '5000';
const MONGO_CONNECT_TIMEOUT_MS = '5000';
const MONGO_SOCKET_TIMEOUT_MS = '10000';
const MONGO_ADVANCED_OPTIONS = JSON.stringify({ serverSelectionTimeoutMS: 5000 });
const sourceTab = SOURCE_TAB_LABELS
  .map((label) => flow.find((node) => (
    node?.type === 'tab'
    && node?.label === label
    && node?.disabled !== true
  )))
  .find(Boolean);
if (!sourceTab?.id) {
  throw new Error(`Source tab not found in modular source flow: ${SOURCE_TAB_LABELS.join(' or ')}`);
}
const tabId = sourceTab.id;
const isInGamesTab = (node) => node?.z === tabId;
const isInLegacyResultTab = (node) => {
  const tab = byId.get(node?.z);
  return tab?.type === 'tab' && tab?.label === LEGACY_RESULT_TAB_LABEL;
};
const findNode = (predicate, label) => {
  const node = flow.find(predicate);
  if (!node) throw new Error(`Node not found: ${label}`);
  return node;
};
const findTabNode = (predicate, label) => findNode((item) => isInGamesTab(item) && predicate(item), label);
const findNodes = (predicate, label) => {
  const nodes = flow.filter(predicate);
  if (nodes.length === 0) throw new Error(`Nodes not found: ${label}`);
  return nodes;
};
const replaceFunction = (name, file) => {
  const node = findTabNode((item) => item.type === 'function' && item.name === name, name);
  const nextFunc = readFn(file);
  node.func = nextFunc;
  findNodes(
    (item) => (
      item?.type === 'function'
      && item?.name === name
      && (isInGamesTab(item) || isInLegacyResultTab(item))
    ),
    `${name} duplicates`,
  ).forEach((duplicateNode) => {
    duplicateNode.func = nextFunc;
  });
  return node;
};
const getSingleWireTarget = (node, outputIndex, label) => {
  const targetId = Array.isArray(node?.wires?.[outputIndex]) ? node.wires[outputIndex][0] : null;
  if (!targetId) {
    throw new Error(`Wire target not found: ${label}`);
  }
  const target = byId.get(targetId);
  if (!target) {
    throw new Error(`Wired node not found: ${label}`);
  }
  return target;
};
const nodeAliases = new Map();
const isManagedResultId = (id) => /^result_[a-z0-9_]+_00\d$/i.test(String(id || ''));
const redirectNodeReferences = (fromId, toId) => {
  if (!fromId || !toId || fromId === toId) return;
  flow.forEach((item) => {
    if (Array.isArray(item.wires)) {
      item.wires = item.wires.map((wire) => (
        Array.isArray(wire)
          ? Array.from(new Set(wire.map((targetId) => (targetId === fromId ? toId : targetId))))
          : wire
      ));
    }
    for (const field of ['scope', 'links']) {
      if (Array.isArray(item[field])) {
        item[field] = Array.from(new Set(item[field].map((targetId) => (
          targetId === fromId ? toId : targetId
        ))));
      }
    }
  });
};
const findEnsureCandidates = (node) => flow.filter((item) => {
  if (!isInGamesTab(item) || item?.type !== node?.type) return false;
  if (node.type === 'http in') {
    return item.method === node.method && item.url === node.url;
  }
  return Boolean(node.name) && item.name === node.name;
});
const ensureNode = (node) => {
  const candidates = findEnsureCandidates(node);
  const existing = candidates.find((item) => !isManagedResultId(item.id))
    || byId.get(node.id)
    || candidates[0]
    || null;
  if (existing) {
    const existingId = existing.id;
    candidates
      .filter((item) => item.id !== existingId)
      .forEach((duplicate) => {
        redirectNodeReferences(duplicate.id, existingId);
        const duplicateIndex = flow.findIndex((item) => item.id === duplicate.id);
        if (duplicateIndex !== -1) flow.splice(duplicateIndex, 1);
        byId.delete(duplicate.id);
      });
    Object.assign(existing, node, { id: existingId });
    nodeAliases.set(node.id, existingId);
    byId.set(existingId, existing);
    byId.set(node.id, existing);
    return existing;
  } else {
    flow.push(node);
    byId.set(node.id, node);
    return node;
  }
};
const removeNode = (id) => {
  const index = flow.findIndex((node) => node.id === id);
  if (index !== -1) flow.splice(index, 1);
  byId.delete(id);
};
const resolveNodeAlias = (id) => {
  let resolved = id;
  const visited = new Set();
  while (nodeAliases.has(resolved) && !visited.has(resolved)) {
    visited.add(resolved);
    resolved = nodeAliases.get(resolved);
  }
  return resolved;
};
const applyNodeAliases = () => {
  flow.forEach((item) => {
    if (Array.isArray(item.wires)) {
      item.wires = item.wires.map((wire) => (
        Array.isArray(wire)
          ? Array.from(new Set(wire.map((targetId) => resolveNodeAlias(targetId))))
          : wire
      ));
    }
    for (const field of ['scope', 'links']) {
      if (Array.isArray(item[field])) {
        item[field] = Array.from(new Set(item[field].map((targetId) => resolveNodeAlias(targetId))));
      }
    }
  });
};
const dedupeResultHttpRoutes = () => {
  const groups = new Map();
  flow
    .filter((item) => (
      isInGamesTab(item)
      && item?.type === 'http in'
      && typeof item.url === 'string'
      && item.url.includes('/result/')
    ))
    .forEach((item) => {
      const key = `${item.method || ''} ${item.url}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
  groups.forEach((nodes) => {
    if (nodes.length < 2) return;
    const keep = nodes.find((item) => !isManagedResultId(item.id)) || nodes[0];
    nodes.filter((item) => item.id !== keep.id).forEach((duplicate) => {
      redirectNodeReferences(duplicate.id, keep.id);
      removeNode(duplicate.id);
    });
  });
};

const statePrepare = replaceFunction('Result state validate', 'fn_result_state_prepare.js');
const stateBuildQuery = replaceFunction('Build result state query', 'fn_result_state_build_query.js');
const stateResponse = replaceFunction('Build result state response', 'fn_result_state_response.js');
const submitPrepare = replaceFunction('Result submit validate', 'fn_result_submit_prepare.js');
const submitBuildQuery = replaceFunction('Validate submitter + build query', 'fn_result_submit_build_query.js');
const submitBuildInsert = replaceFunction('Build pending result doc', 'fn_result_submit_build_insert.js');
const submitResponse = replaceFunction('Submit result response', 'fn_result_submit_response.js');
const confirmPrepare = replaceFunction('Result confirm validate', 'fn_result_confirm_prepare.js');
const confirmBuildResults = replaceFunction('Validate confirmer + build results query', 'fn_result_confirm_build_results_query.js');
const confirmPrepareRatings = replaceFunction('Pick pending + build ratings query', 'fn_result_confirm_prepare_ratings_query.js');
const confirmApply = replaceFunction('Confirm result + calc rating', 'fn_result_confirm_apply.js');
const confirmResultUpdateFormatter = findTabNode((node) => node.name === 'Update result confirmed -> mongodb4 args', 'confirm result update formatter');
const ratingLedgerEventFormatter = replaceFunction('Build rating update msg', 'fn_result_rating_ledger_event_msg.js');
const ratingLedgerStateFormatter = replaceFunction('Upsert player rating -> mongodb4 args', 'fn_result_rating_ledger_state_msg.js');

submitBuildInsert.outputs = 6;
confirmApply.outputs = 6;

const submitResultWrite = findTabNode(
  (node) => node.name === 'Insert pending result' || node.name === 'Upsert pending result',
  'submit result write',
);
submitResultWrite.name = 'Upsert pending result';
submitResultWrite.operation = 'updateOne';
submitResultWrite.output = 'toArray';

const submitFindGame = findTabNode((node) => node.name === 'Find game for result submit', 'submit game lookup');
const submitFindResults = findTabNode((node) => node.name === 'Find existing game results', 'submit existing results lookup');
const submitHttpResp = getSingleWireTarget(submitPrepare, 1, 'submit http response');
const submitDebug = getSingleWireTarget(submitPrepare, 2, 'submit debug');
const confirmFindGame = findTabNode((node) => node.name === 'Find game for result confirm', 'confirm game lookup');
const confirmFindResults = findTabNode((node) => node.name === 'Find pending results', 'confirm results lookup');
const mongoClient = submitResultWrite.clientNode;
const mongoClientNode = byId.get(mongoClient);
if (!mongoClientNode) throw new Error('Mongo client node not found for results flow');
const playerRatingWrite = findTabNode((node) => node.name === 'Upsert player rating', 'player rating state write');
playerRatingWrite.collection = 'player_rating_state';

mongoClientNode.connectTimeoutMS = MONGO_CONNECT_TIMEOUT_MS;
mongoClientNode.socketTimeoutMS = MONGO_SOCKET_TIMEOUT_MS;
mongoClientNode.advanced = MONGO_ADVANCED_OPTIONS;
submitFindGame.maxTimeMS = SUBMIT_MONGO_MAX_TIME_MS;
submitFindResults.maxTimeMS = SUBMIT_MONGO_MAX_TIME_MS;
submitResultWrite.maxTimeMS = SUBMIT_MONGO_MAX_TIME_MS;
confirmFindGame.maxTimeMS = RESULT_MONGO_MAX_TIME_MS;
confirmFindResults.maxTimeMS = RESULT_MONGO_MAX_TIME_MS;
playerRatingWrite.maxTimeMS = RESULT_MONGO_MAX_TIME_MS;

const sessionOpenHttp = ensureNode({
  id: 'result_session_open_http_in_002',
  type: 'http in',
  z: tabId,
  name: 'LK game result session open',
  url: '/lk/games/:gameId/result/session/open',
  method: 'post',
  upload: false,
  swaggerDoc: '',
  x: 170,
  y: 3700,
  wires: [['result_session_open_prepare_002']],
});
const sessionOpenPrepare = ensureNode({
  id: 'result_session_open_prepare_002',
  type: 'function',
  z: tabId,
  name: 'Result session open validate',
  func: readFn('fn_result_session_open_prepare.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 470,
  y: 3700,
  wires: [['result_session_open_find_game_002'], [submitHttpResp.id], [submitDebug.id]],
});
const sessionOpenFindGame = ensureNode({
  id: 'result_session_open_find_game_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_games',
  operation: 'find',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Find game for result session open',
  x: 780,
  y: 3700,
  wires: [['result_session_open_prepare_query_002']],
});
const sessionOpenPrepareQuery = ensureNode({
  id: 'result_session_open_prepare_query_002',
  type: 'function',
  z: tabId,
  name: 'Prepare result session query',
  func: readFn('fn_result_session_open_prepare_session_query.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1080,
  y: 3700,
  wires: [['result_session_open_find_existing_002'], [submitHttpResp.id], [submitDebug.id]],
});
const sessionOpenFindExisting = ensureNode({
  id: 'result_session_open_find_existing_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_game_result_sessions',
  operation: 'find',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Find existing result session',
  x: 1360,
  y: 3700,
  wires: [['result_session_open_build_002']],
});
const sessionOpenBuild = ensureNode({
  id: 'result_session_open_build_002',
  type: 'function',
  z: tabId,
  name: 'Build result session response',
  func: readFn('fn_result_session_open_build.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1640,
  y: 3700,
  wires: [['result_session_open_upsert_002'], [submitHttpResp.id], [submitDebug.id]],
});
const sessionOpenWrite = ensureNode({
  id: 'result_session_open_upsert_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_game_result_sessions',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Upsert result session',
  x: 1910,
  y: 3700,
  wires: [['result_session_open_after_write_003']],
});
const sessionOpenAfterWrite = ensureNode({
  id: 'result_session_open_after_write_003',
  type: 'function',
  z: tabId,
  name: 'Respond after result session open write',
  func: readFn('fn_result_session_open_after_write.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 2180,
  y: 3700,
  wires: [[submitHttpResp.id], [submitDebug.id]],
});
const sessionUpdateHttp = ensureNode({
  id: 'result_session_update_http_in_002',
  type: 'http in',
  z: tabId,
  name: 'LK game result session update',
  url: '/lk/games/:gameId/result/session/:sessionId',
  method: 'patch',
  upload: false,
  swaggerDoc: '',
  x: 170,
  y: 3740,
  wires: [['result_session_update_prepare_002']],
});
const sessionUpdatePrepare = ensureNode({
  id: 'result_session_update_prepare_002',
  type: 'function',
  z: tabId,
  name: 'Result session update validate',
  func: readFn('fn_result_session_update_prepare.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 470,
  y: 3740,
  wires: [['result_session_update_find_002'], [submitHttpResp.id], [submitDebug.id]],
});
const sessionUpdateFind = ensureNode({
  id: 'result_session_update_find_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_game_result_sessions',
  operation: 'find',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Find result session for update',
  x: 800,
  y: 3740,
  wires: [['result_session_update_build_002']],
});
const sessionUpdateBuild = ensureNode({
  id: 'result_session_update_build_002',
  type: 'function',
  z: tabId,
  name: 'Apply result session update',
  func: readFn('fn_result_session_update_build.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1090,
  y: 3740,
  wires: [['result_session_update_write_002'], [submitHttpResp.id], [submitDebug.id]],
});
const sessionUpdateWrite = ensureNode({
  id: 'result_session_update_write_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_game_result_sessions',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Update result session draft',
  x: 1360,
  y: 3740,
  wires: [['result_session_update_after_write_003']],
});
const sessionUpdateAfterWrite = ensureNode({
  id: 'result_session_update_after_write_003',
  type: 'function',
  z: tabId,
  name: 'Respond after result session update CAS',
  func: readFn('fn_result_session_update_after_write.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1640,
  y: 3740,
  wires: [[submitHttpResp.id], [submitDebug.id]],
});

submitFindResults.wires = [[submitBuildInsert.id]];
const submitGameProjection = ensureNode({
  id: 'result_submit_update_game_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_games',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Update game provisional result status',
  x: 1740,
  y: 3900,
  wires: [[]],
});
const submitEventProjection = ensureNode({
  id: 'result_submit_upsert_event_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_game_rating_events',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Upsert provisional rating event',
  x: 1740,
  y: 3940,
  wires: [[]],
});
const submitAfterWrite = ensureNode({
  id: 'result_submit_after_write_003',
  type: 'function',
  z: tabId,
  name: 'Route submit after durable result write',
  func: readFn('fn_result_submit_after_write.js'),
  outputs: 5,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1990,
  y: 3800,
  wires: [
    [submitResponse.id],
    [submitGameProjection.id],
    [submitEventProjection.id],
    [submitHttpResp.id],
    [submitDebug.id],
  ],
});

submitBuildInsert.wires = [
  [submitResultWrite.id],
  [submitHttpResp.id],
  [submitDebug.id],
  [],
  [],
  [],
];
submitResultWrite.wires = [[submitAfterWrite.id]];

const resultWriteErrorResponse = ensureNode({
  id: 'result_write_error_response_003',
  type: 'function',
  z: tabId,
  name: 'Build result persistence error response',
  func: readFn('fn_result_write_error_response.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 2050,
  y: 3740,
  wires: [[submitHttpResp.id], [submitDebug.id]],
});
ensureNode({
  id: 'result_pre_ack_catch_003',
  type: 'catch',
  z: tabId,
  name: 'Catch result persistence before HTTP ack',
  scope: [
    sessionOpenPrepare.id,
    sessionOpenFindGame.id,
    sessionOpenPrepareQuery.id,
    sessionOpenFindExisting.id,
    sessionOpenBuild.id,
    sessionOpenWrite.id,
    sessionOpenAfterWrite.id,
    sessionUpdatePrepare.id,
    sessionUpdateFind.id,
    sessionUpdateBuild.id,
    sessionUpdateWrite.id,
    sessionUpdateAfterWrite.id,
    submitPrepare.id,
    submitFindGame.id,
    submitBuildQuery.id,
    submitFindResults.id,
    submitBuildInsert.id,
    submitResultWrite.id,
    submitAfterWrite.id,
  ],
  uncaught: false,
  x: 1710,
  y: 3660,
  wires: [[resultWriteErrorResponse.id]],
});

const confirmHttp = findTabNode((node) => node.type === 'http in' && node.url === '/lk/games/:gameId/result/confirm', 'confirm http');
const confirmHttpResp = getSingleWireTarget(confirmPrepare, 1, 'confirm http response');
const confirmDebug = getSingleWireTarget(confirmPrepare, 2, 'confirm debug');
const confirmResultUpdateWrite = findTabNode((node) => node.name === 'Update result confirmed', 'confirm result update write');
const confirmFindRatings = ensureNode({
  id: 'result_confirm_find_live_ratings_003',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'player_rating_state',
  operation: 'find',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Find live ratings for result confirm',
  x: 1590,
  y: 4020,
  wires: [['result_confirm_calculate_rating_003']],
});
const confirmCalculateRating = ensureNode({
  id: 'result_confirm_calculate_rating_003',
  type: 'function',
  z: tabId,
  name: 'Calculate result rating from live state',
  func: readFn('fn_result_confirm_calculate_rating.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1900,
  y: 4020,
  wires: [[confirmApply.id], [confirmHttpResp.id], [confirmDebug.id]],
});
confirmPrepareRatings.wires = [[confirmFindRatings.id], [confirmHttpResp.id], [confirmDebug.id]];
confirmFindRatings.wires = [[confirmCalculateRating.id]];
const disputeHttp = ensureNode({
  id: 'result_dispute_in_002',
  type: 'http in',
  z: confirmHttp.z,
  name: 'LK game result dispute',
  url: '/lk/games/:gameId/result/dispute',
  method: 'post',
  upload: false,
  swaggerDoc: '',
  x: 150,
  y: 4020,
  wires: [[confirmPrepare.id]],
});
const revertHttp = ensureNode({
  id: 'result_revert_in_002',
  type: 'http in',
  z: confirmHttp.z,
  name: 'LK game result revert',
  url: '/lk/games/:gameId/result/revert',
  method: 'post',
  upload: false,
  swaggerDoc: '',
  x: 150,
  y: 4060,
  wires: [[confirmPrepare.id]],
});
const acceptCorrectionHttp = ensureNode({
  id: 'result_accept_correction_in_002',
  type: 'http in',
  z: confirmHttp.z,
  name: 'LK game result accept correction',
  url: '/lk/games/:gameId/result/accept-correction',
  method: 'post',
  upload: false,
  swaggerDoc: '',
  x: 180,
  y: 4100,
  wires: [[confirmPrepare.id]],
});

const expireHttp = ensureNode({
  id: 'result_expire_http_in_002',
  type: 'http in',
  z: confirmHttp.z,
  name: 'LK game result expire',
  url: '/lk/games/:gameId/result/expire',
  method: 'post',
  upload: false,
  swaggerDoc: '',
  x: 170,
  y: 4140,
  wires: [[confirmPrepare.id]],
});

const stateHttp = findTabNode(
  (node) => node.type === 'http in' && node.url === '/lk/games/:gameId/result/state',
  'result state http',
);
const submitHttp = findTabNode(
  (node) => node.type === 'http in' && node.url === '/lk/games/:gameId/result/submit',
  'result submit http',
);
const resultAuthPrepare = ensureNode({
  id: 'result_actor_auth_prepare_001',
  type: 'function',
  z: tabId,
  name: 'Prepare result actor authentication',
  func: readFn('fn_result_auth_prepare.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 420,
  y: 3560,
  wires: [['result_actor_auth_profile_request_001'], [submitHttpResp.id]],
});
ensureNode({
  id: 'result_actor_auth_profile_request_001',
  type: 'http request',
  z: tabId,
  name: 'Verify result actor via Viva profile',
  method: 'use',
  ret: 'obj',
  paytoqs: 'ignore',
  url: '',
  tls: '',
  persist: false,
  proxy: '',
  insecureHTTPParser: false,
  authType: '',
  senderr: true,
  headers: [],
  x: 760,
  y: 3560,
  wires: [['result_actor_auth_profile_001']],
});
ensureNode({
  id: 'result_actor_auth_profile_001',
  type: 'function',
  z: tabId,
  name: 'Resolve verified result actor',
  func: readFn('fn_result_auth_profile.js'),
  outputs: 6,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1070,
  y: 3560,
  wires: [
    [statePrepare.id],
    [submitPrepare.id],
    [confirmPrepare.id],
    [sessionOpenPrepare.id],
    [sessionUpdatePrepare.id],
    [submitHttpResp.id],
  ],
});
[
  stateHttp,
  submitHttp,
  confirmHttp,
  disputeHttp,
  revertHttp,
  acceptCorrectionHttp,
  expireHttp,
  sessionOpenHttp,
  sessionUpdateHttp,
].forEach((node) => {
  node.wires = [[resultAuthPrepare.id]];
});
ensureNode({
  id: 'result_confirm_upsert_event_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_game_rating_events',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Update rating event lifecycle',
  x: 2290,
  y: 4020,
  wires: [[]],
});
ensureNode({
  id: 'result_rating_ledger_append_001',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'rating_events',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Append canonical rating event',
  x: 2740,
  y: 3940,
  wires: [[ratingLedgerStateFormatter.id]],
});
ensureNode({
  id: 'result_rating_ledger_projection_001',
  type: 'function',
  z: tabId,
  name: 'Project canonical rating to Viva',
  func: readFn('fn_result_rating_ledger_projection_msg.js'),
  outputs: 1,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 2960,
  y: 3940,
  wires: [['result_viva_sync_outbox_prepare_002', 'result_viva_sync_request_prepare_002']],
});
ensureNode({
  id: 'result_rating_compatibility_prepare_001',
  type: 'function',
  z: tabId,
  name: 'Build player_ratings compatibility projection',
  func: readFn('fn_result_rating_compatibility_msg.js'),
  outputs: 1,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 2960,
  y: 3980,
  wires: [['result_rating_compatibility_write_001']],
});
ensureNode({
  id: 'result_rating_compatibility_write_001',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'player_ratings',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Project canonical state to player_ratings',
  x: 3270,
  y: 3980,
  wires: [['result_rating_ledger_projection_001']],
});
ratingLedgerEventFormatter.wires = [['result_rating_ledger_append_001']];
ratingLedgerStateFormatter.wires = [[playerRatingWrite.id]];
playerRatingWrite.wires = [['result_rating_compatibility_prepare_001']];
ensureNode({
  id: 'result_confirm_route_after_cas_002',
  type: 'function',
  z: tabId,
  name: 'Route confirm after CAS',
  func: readFn('fn_result_confirm_route_after_cas.js'),
  outputs: 6,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 2540,
  y: 3860,
  wires: [
    [findTabNode((node) => node.name === 'Split ratings updates', 'ratings split node').id],
    [findTabNode((node) => node.name === 'Update game result status -> mongodb4 args', 'game result update formatter').id],
    [confirmHttpResp.id],
    [confirmDebug.id],
    ['result_confirm_upsert_event_002'],
    ['result_viva_sync_split_002'],
  ],
});
ensureNode({
  id: 'result_viva_sync_split_002',
  type: 'split',
  z: tabId,
  name: 'Split Viva sync tasks',
  arraySplt: 1,
  arraySpltType: 'len',
  stream: false,
  addname: '',
  property: 'payload',
  x: 2830,
  y: 3780,
  wires: [['result_viva_sync_outbox_prepare_002', 'result_viva_sync_request_prepare_002']],
});
ensureNode({
  id: 'result_viva_sync_outbox_prepare_002',
  type: 'function',
  z: tabId,
  name: 'Prepare Viva sync outbox',
  func: readFn('fn_result_viva_sync_outbox_prepare.js'),
  outputs: 1,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 3090,
  y: 3740,
  wires: [['result_viva_sync_outbox_upsert_002']],
});
ensureNode({
  id: 'result_viva_sync_outbox_upsert_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_result_viva_sync_outbox',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Upsert Viva sync outbox',
  x: 3360,
  y: 3740,
  wires: [[]],
});
ensureNode({
  id: 'result_viva_sync_request_prepare_002',
  type: 'function',
  z: tabId,
  name: 'Prepare Viva sync request',
  func: readFn('fn_result_viva_sync_request_prepare.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 3080,
  y: 3820,
  wires: [['result_viva_sync_http_002'], ['result_viva_sync_handle_002'], [confirmDebug.id]],
});
ensureNode({
  id: 'result_viva_sync_http_002',
  type: 'http request',
  z: tabId,
  name: 'POST Viva sync via onboarding level',
  method: 'use',
  ret: 'obj',
  paytoqs: 'ignore',
  url: '',
  requestTimeout: '20000',
  senderr: false,
  persist: false,
  proxy: '',
  insecureHTTPParser: false,
  authType: '',
  headers: [],
  x: 3380,
  y: 3820,
  wires: [['result_viva_sync_handle_002']],
});
ensureNode({
  id: 'result_viva_sync_handle_002',
  type: 'function',
  z: tabId,
  name: 'Handle Viva sync response',
  func: readFn('fn_result_viva_sync_handle_response.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 3650,
  y: 3820,
  wires: [['result_viva_sync_outbox_status_002'], ['result_viva_sync_join_002'], ['result_viva_sync_prepare_summary_query_002']],
});
ensureNode({
  id: 'result_viva_sync_outbox_status_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_result_viva_sync_outbox',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Update Viva sync outbox status',
  x: 3940,
  y: 3780,
  wires: [[]],
});
ensureNode({
  id: 'result_viva_sync_prepare_summary_query_002',
  type: 'function',
  z: tabId,
  name: 'Prepare Viva sync summary query',
  func: readFn('fn_result_viva_sync_prepare_summary_query.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 3940,
  y: 3900,
  wires: [['result_viva_sync_find_batch_002'], [confirmDebug.id]],
});
ensureNode({
  id: 'result_viva_sync_find_batch_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_result_viva_sync_outbox',
  operation: 'find',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Find Viva sync batch rows',
  x: 4230,
  y: 3900,
  wires: [['result_viva_sync_rebuild_summary_002']],
});
ensureNode({
  id: 'result_viva_sync_rebuild_summary_002',
  type: 'function',
  z: tabId,
  name: 'Rebuild Viva sync summary',
  func: readFn('fn_result_viva_sync_rebuild_summary.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 4510,
  y: 3900,
  wires: [['result_viva_sync_update_result_args_002'], [confirmDebug.id], [confirmDebug.id]],
});
ensureNode({
  id: 'result_viva_sync_join_002',
  type: 'join',
  z: tabId,
  name: 'Join Viva sync results',
  mode: 'auto',
  build: 'array',
  property: 'payload',
  propertyType: 'msg',
  key: 'topic',
  joiner: '\\n',
  joinerType: 'str',
  accumulate: false,
  timeout: '',
  count: '',
  reduceRight: false,
  reduceExp: '',
  reduceInit: '',
  reduceInitType: '',
  reduceFixup: '',
  x: 3930,
  y: 3860,
  wires: [['result_viva_sync_finalize_002']],
});
ensureNode({
  id: 'result_viva_sync_finalize_002',
  type: 'function',
  z: tabId,
  name: 'Finalize Viva sync batch',
  func: readFn('fn_result_viva_sync_finalize_batch.js'),
  outputs: 3,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 4200,
  y: 3860,
  wires: [['result_viva_sync_update_result_args_002'], [confirmHttpResp.id], [confirmDebug.id]],
});
ensureNode({
  id: 'result_viva_sync_update_result_args_002',
  type: 'function',
  z: tabId,
  name: 'Update Viva sync summary -> mongodb4 args',
  func: confirmResultUpdateFormatter.func,
  outputs: 1,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 4520,
  y: 3820,
  wires: [['result_viva_sync_update_result_002']],
});
ensureNode({
  id: 'result_viva_sync_update_result_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_game_results',
  operation: 'updateOne',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Update Viva sync summary',
  x: 4780,
  y: 3820,
  wires: [[]],
});
ensureNode({
  id: 'result_viva_sync_retry_inject_002',
  type: 'inject',
  z: tabId,
  name: 'Retry failed Viva sync outbox (10m)',
  props: [
    { p: 'payload' },
    { p: 'topic', vt: 'str' },
  ],
  repeat: '600',
  crontab: '',
  once: false,
  onceDelay: 0.1,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 220,
  y: 4300,
  wires: [['result_viva_sync_retry_query_002']],
});
ensureNode({
  id: 'result_viva_sync_retry_query_002',
  type: 'function',
  z: tabId,
  name: 'Build Viva sync retry query',
  func: readFn('fn_result_viva_sync_retry_query.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 500,
  y: 4300,
  wires: [['result_viva_sync_retry_find_002'], [confirmDebug.id]],
});
ensureNode({
  id: 'result_viva_sync_retry_find_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_result_viva_sync_outbox',
  operation: 'find',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Find failed Viva sync outbox',
  x: 790,
  y: 4300,
  wires: [['result_viva_sync_retry_split_002']],
});
ensureNode({
  id: 'result_viva_sync_retry_split_002',
  type: 'split',
  z: tabId,
  name: 'Split failed Viva sync outbox',
  property: 'payload',
  propertyType: 'msg',
  arraySplt: 1,
  arraySpltType: 'len',
  stream: false,
  addname: '',
  x: 1080,
  y: 4300,
  wires: [['result_viva_sync_retry_prepare_002']],
});
ensureNode({
  id: 'result_viva_sync_retry_prepare_002',
  type: 'function',
  z: tabId,
  name: 'Prepare Viva sync retry task',
  func: readFn('fn_result_viva_sync_retry_prepare.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1370,
  y: 4300,
  wires: [['result_viva_sync_request_prepare_002'], [confirmDebug.id]],
});
ensureNode({
  id: 'result_expire_cron_in_002',
  type: 'inject',
  z: tabId,
  name: 'Expire correction pending results (cron)',
  props: [
    { p: 'payload' },
    { p: 'topic', vt: 'str' },
  ],
  repeat: '300',
  crontab: '',
  once: false,
  onceDelay: 0.1,
  topic: '',
  payload: '',
  payloadType: 'date',
  x: 200,
  y: 4220,
  wires: [['result_expire_fn_query_002']],
});
ensureNode({
  id: 'result_expire_fn_query_002',
  type: 'function',
  z: tabId,
  name: 'Build expired correction query',
  func: readFn('fn_result_expire_build_query.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 470,
  y: 4220,
  wires: [['result_expire_find_results_002'], [confirmDebug.id]],
});
ensureNode({
  id: 'result_expire_find_results_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_game_results',
  operation: 'find',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Find expired correction results',
  x: 760,
  y: 4220,
  wires: [['result_expire_split_002']],
});
ensureNode({
  id: 'result_expire_split_002',
  type: 'split',
  z: tabId,
  name: 'Split expired results',
  property: 'payload',
  propertyType: 'msg',
  arraySplt: 1,
  arraySpltType: 'len',
  stream: false,
  addname: '',
  x: 1030,
  y: 4220,
  wires: [['result_expire_fn_prepare_game_002']],
});
ensureNode({
  id: 'result_expire_fn_prepare_game_002',
  type: 'function',
  z: tabId,
  name: 'Prepare expire context + game query',
  func: readFn('fn_result_expire_prepare_game_query.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1330,
  y: 4220,
  wires: [['result_expire_find_game_002'], [confirmDebug.id]],
});
ensureNode({
  id: 'result_expire_find_game_002',
  type: 'mongodb4',
  z: tabId,
  clientNode: mongoClient,
  mode: 'collection',
  collection: 'lk_games',
  operation: 'find',
  output: 'toArray',
  maxTimeMS: RESULT_MONGO_MAX_TIME_MS,
  handleDocId: false,
  name: 'Find game for expired result',
  x: 1600,
  y: 4220,
  wires: [['result_expire_fn_attach_game_002']],
});
ensureNode({
  id: 'result_expire_fn_attach_game_002',
  type: 'function',
  z: tabId,
  name: 'Attach game and trigger expire apply',
  func: readFn('fn_result_expire_attach_game.js'),
  outputs: 2,
  timeout: '',
  noerr: 0,
  initialize: '',
  finalize: '',
  libs: [],
  x: 1880,
  y: 4220,
  wires: [[confirmApply.id], [confirmDebug.id]],
});
confirmApply.wires = [
  [confirmResultUpdateFormatter.id],
  [],
  [],
  [confirmHttpResp.id],
  [confirmDebug.id],
  [],
];
confirmResultUpdateWrite.wires = [['result_confirm_route_after_cas_002']];

const comment = findTabNode(
  (node) => node.type === 'comment' && String(node.name || '').includes('LK game results'),
  'results lifecycle comment',
);
if (comment) {
  comment.name = 'LK game results lifecycle + CUP canonical rating ledger';
  comment.info = 'States: NO_RESULT, PENDING_REVIEW, CONFIRMED, DISPUTED, CORRECTION_PENDING, NO_RESULT_EXPIRED. Session open/update return success only after Mongo persistence; update uses revision CAS. V2 submit validates pairings, persists immutable score facts plus durable ratingWork=QUEUED, and returns 202 without calculating rating. The separate game-result worker leases work, stores a deterministic plan, appends immutable rating_events, replays player_rating_state, and writes compatibility/Viva projections. A dispute queues REVERTED work; an author correction creates a new scoreRevision and waits for predecessor compensation. Legacy V1 confirm-time rating nodes remain for existing records only.';
}

// Remove obsolete nodes from the pre-session / provisional-submit topology.
for (const removableId of [
  'result_submit_split_ratings_002',
  'result_submit_fn_rating_msg_002',
    'result_submit_update_rating_002',
    'result_submit_prepare_ratings_query_002',
    'result_submit_find_ratings_002',
  'result_confirm_in_001',
]) {
  removeNode(removableId);
}
for (const removableName of [
  'Split provisional ratings updates',
  'Build provisional rating update msg',
    'Upsert provisional player rating',
    'Prepare live rating query',
    'Find live player ratings',
  'Find players for dispute context',
  'Find players ratings',
]) {
  const node = flow.find((item) => isInGamesTab(item) && item.name === removableName);
  if (node) removeNode(node.id);
}

dedupeResultHttpRoutes();
applyNodeAliases();

fs.writeFileSync(sourcePath, `${JSON.stringify(flow, null, 2)}\n`, 'utf8');
console.log(`Patched result lifecycle nodes in ${sourcePath}`);
console.log(`Function nodes synced: ${[
  statePrepare, stateBuildQuery, stateResponse, submitPrepare, submitBuildQuery,
  submitBuildInsert, submitResponse, confirmPrepare, confirmBuildResults,
  confirmPrepareRatings, confirmCalculateRating, confirmApply, ratingLedgerEventFormatter,
  ratingLedgerStateFormatter,
].length}`);

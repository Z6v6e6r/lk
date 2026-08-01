#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const CHAT_FN_DIR = path.join(SCRIPT_DIR, "nodered_chat_nodes");
const PARTICIPANTS_FN_DIR = path.join(SCRIPT_DIR, "nodered_tournament_participants_nodes");
const EXPECTED_SOURCE_SHA256 = "087cd7ca973681c5cf7585c97a0c8498b38d7eb214aede2f83b64ef49555946e";
const EXPECTED_NODE_COUNT = 4628;
const EXPECTED_ROUTE_COUNT = 203;
const TAB_ID = "4b91e2a2413688db";
const ids = Object.freeze({
  httpIn: "ecf32036257013bd",
  auth: "7c280001a0c1e011",
  profileHttp: "7c280001a0c1e012",
  actor: "7c280001a0c1e013",
  prepare: "016d6797a530ed0a",
  gameFind: "7c280001a0c1e014",
  authorize: "7c280001a0c1e015",
  vivaHttp: "52af61191cdbe9ef",
  router: "9878400d518ebcbd",
  response: "35f7c89069fc393a",
  debug: "cf731009d4167f78",
  operationStartBuild: "lk_split_leave_operation_start_build_20260801",
  operationStartUpdate: "lk_split_leave_operation_start_update_20260801",
  operationFindBuild: "lk_split_leave_operation_find_build_20260801",
  operationFind: "lk_split_leave_operation_find_20260801",
  operationRoute: "lk_split_leave_operation_route_20260801",
  operationClaimBuild: "lk_split_leave_operation_claim_build_20260801",
  operationClaimUpdate: "lk_split_leave_operation_claim_update_20260801",
  operationClaimAck: "lk_split_leave_operation_claim_ack_20260801",
  operationVivaBuild: "lk_split_leave_operation_viva_build_20260801",
  operationVivaUpdate: "lk_split_leave_operation_viva_update_20260801",
  operationVivaAck: "lk_split_leave_operation_viva_ack_20260801",
  chatBuild: "lk_split_leave_chat_cleanup_build_20260801",
  chatUpdate: "lk_split_leave_chat_cleanup_update_20260801",
  gameBuild: "lk_split_leave_game_update_build_20260801",
  gameUpdate: "lk_split_leave_game_update_20260801",
  operationDoneBuild: "lk_split_leave_operation_done_build_20260801",
  operationDoneUpdate: "lk_split_leave_operation_done_update_20260801",
  operationDoneAck: "lk_split_leave_operation_done_ack_20260801",
  operationDoneFind: "lk_split_leave_operation_done_find_20260801",
  operationDoneReadback: "lk_split_leave_operation_done_readback_20260801",
  finalize: "lk_split_leave_finalize_20260801",
  retry: "lk_split_leave_retry_response_20260801",
  persistenceCatch: "lk_split_leave_persistence_catch_20260801",
  retryInject: "lk_split_leave_retry_inject_20260801",
  retryQuery: "lk_split_leave_retry_query_20260801",
  retryOperationFind: "lk_split_leave_retry_operation_find_20260801",
  retrySelect: "lk_split_leave_retry_select_20260801",
  retryClaimUpdate: "lk_split_leave_retry_claim_update_20260801",
  retryClaimAck: "lk_split_leave_retry_claim_ack_20260801",
  retryGameFind: "lk_split_leave_retry_game_find_20260801",
  retryHydrate: "lk_split_leave_retry_hydrate_20260801",
  gameAck: "lk_split_leave_game_ack_20260801",
  chatAck: "lk_split_leave_chat_ack_20260801",
  generationFenceFind: "lk_split_leave_generation_fence_find_20260801",
  generationFence: "lk_split_leave_generation_fence_20260801",
  listNormalize: "0485dea01865b2dd",
  chatSendRoute: "e09a686660cfb90e",
  chatGetRoute: "87f3e06c0819bba9",
  chatReadRoute: "c70dc6616359a74d",
  chatListRoute: "c2d79e1052eaffd8",
  chatSendPrepare: "a17b63049cd6b53e",
  chatSendBuild: "0f38c94e369cf7ca",
  chatGetPrepare: "5ab2c47e87907d6d",
  chatGetBuild: "1dbd5de98e73a04c",
  chatReadPrepare: "13e99b0963e03eff",
  chatReadBuild: "ff6908fd005f9b0c",
  chatListPrepare: "6b2d00ff210f6501",
  chatListFindMessages: "34c1169305c759cf",
  chatListResponse: "69f47865aa3163d4",
  chatListDebug: "def4413310926e97",
  chatAuthPrepare: "lk_chat_auth_prepare_20260801",
  chatAuthProfile: "lk_chat_auth_profile_request_20260801",
  chatAuthResolve: "lk_chat_auth_resolve_20260801",
  chatAuthResponse: "lk_chat_auth_http_response_20260801",
  chatAuthDebug: "lk_chat_auth_debug_20260801",
  chatListFindGames: "lk_chat_list_find_active_games_20260801",
  chatListBuild: "lk_chat_list_build_messages_query_20260801",
  patchRoute: "7ad34f13c4b25d60",
  patchRecordsRoute: "4cb1e542db56b508",
  patchPrepare: "e0d7883bc1a9fa8c",
  patchArgs: "b2a10027fc45966c",
  patchMongo: "591234d213742276",
  patchResponse: "e17f8a411d4dfa91",
  patchDebug: "3b822085d5f18e97",
  patchAutojoin: "5fc5eaeab97f3f88",
  patchCasGuard: "lk_game_patch_cas_guard_20260801",
  patchCasQuery: "lk_game_patch_apply_cas_20260801",
  patchResponseGate: "lk_game_patch_response_gate_20260801",
  patchAutojoinGate: "lk_game_patch_autojoin_gate_20260801",
  patchAfterWrite: "lk_game_patch_after_write_20260801",
  patchCatch: "lk_game_patch_write_catch_20260801",
  participantsGate: "lk_tournament_participants_cache_gate_20260719",
  participantsTerminal: "lk_tournament_participants_terminal_20260719",
});

const expectedFunctionHashes = Object.freeze({
  [ids.auth]: "354fa99ed0a8fcd82df154373d138c0a98ca3bbd12c1b0c5ae1a440e3ee36e57",
  [ids.actor]: "efb06f89dc604b45232849e1fa3528a492461a332a4d35339ce1af0ef565c61f",
  [ids.prepare]: "c139295e487b2dd66b52719bd352d540926f65db66ac5b0787d1631b52cb0b7c",
  [ids.authorize]: "95e29513063ff8506b4ed4808283ff704044daaee3ed32af0fc5f0cdd5e20800",
  [ids.router]: "38bfcd24c6e71ab0d738f058a559284a1fb1c9df169bb0d88c32667ecd3b93fb",
  [ids.listNormalize]: "aabbe49ef2b7547df800ae95ac0b59579279e3841c635fc8b66356dc52218886",
  [ids.chatSendPrepare]: "45e0888d40a06a0c45d2207aaa5dfa4abfa9d42059c279cb7b8e2c2d5eef3779",
  [ids.chatSendBuild]: "20ac6e7b03e2c753ac827013e2e3d777e600e10a803ae3398d19893a6c90ccaa",
  [ids.chatGetPrepare]: "319831301c285f07edd186408dd68366eb3644169ecc6b5b10e568e9e0bfdc73",
  [ids.chatGetBuild]: "d9bdd9e3ae0255b27f2a1481e0845481842bc7fc598c5047d3ec3ba3ada37959",
  [ids.chatReadPrepare]: "aa16ee2b4ab49077ee65968beeb9e2a293edee3e1e18f55d587295918629fdd8",
  [ids.chatReadBuild]: "16d5918109e8b719b2a4604cf0d8932b109e33121b822fe38f33712c8b69498a",
  [ids.chatListPrepare]: "ff24b11e0501d85dd3e584298b88d1af0eb2bbc6b147f527a23708288e0878a8",
  [ids.patchPrepare]: "7d007ab69297b7ab4314bf23a21cb6fbebcdc6f149e0bfd9d931f0329718261c",
  [ids.patchArgs]: "e0e1e7bd925ccdfda7cf02b8582885822a889a4e82adeda7d7aa4cda68ead6f0",
  [ids.participantsGate]: "9929dbd80c9a2be0b34bce6f8f2d49578d8ffc36855a962b29bef9b73b9df926",
  [ids.participantsTerminal]: "b864560f9be90f6850e0663f991d43d5066b989b807770ba5c43aa99dcdb2628",
});

const expectedCandidateSourceHashes = Object.freeze({
  "games/fn_list_normalize.js": "33d5252688c6f25ab61ef9b3ad157b2ae970bc8d8b60e4264d30dac0a5296172",
  "games/fn_patch_cas_guard.js": "11d21b951b916fc04fb815853c79ff64fcb58f777626a54988b06573a92da374",
  "games/fn_patch_cas_query.js": "17713e19d9f465a4b88fee8decb4c9e94402d51298239ecc0b22b91e90f6377d",
  "games/fn_patch_after_write.js": "e2316241b7148bdc8a76de725215d542e67c57681ee2e2efc51a0b58145c3d88",
  "games/fn_patch_response_gate.js": "551a50d6263f96fd65f69970a034d62d3ffe29d30ab5da6ec2e65c2f588173cd",
  "games/fn_patch_autojoin_gate.js": "551a50d6263f96fd65f69970a034d62d3ffe29d30ab5da6ec2e65c2f588173cd",
  "games/fn_split_leave_prepare.js": "e2653faa2532f546dca497ef683c43b3bf26d3b151ae9b4ab24fb49898bf69d7",
  "games/fn_split_leave_authorize.js": "37ca0d9a981232f1cd5d2cce6259ec666168e372bd4dd1b8bd707e7c17ffe33d",
  "games/fn_split_leave_router.js": "6599a544983714e483ebc23d856c0b817b87440792c525dffc151ddd54dc9c43",
  "games/fn_split_leave_operation_start.js": "ecdf9de8fdf439bf5d6c5a0a925d51bad5975ad5e018f423a07991a402069b23",
  "games/fn_split_leave_operation_find.js": "71c685b424e5bbba7297f773018802c2cffe42a03f5a33176a72b1714599bcdb",
  "games/fn_split_leave_operation_route.js": "04823d77b494aac4870349d4c89f6c9f142c15b08f1623537c5933e0d0c8031f",
  "games/fn_split_leave_operation_claim.js": "33473bed64b8a85da354e386adf95970e90dcd47492c17b3bbca20391924d6bb",
  "games/fn_split_leave_operation_claim_ack.js": "2545d0a211f45b93d8bea6d17d5f7fa0a303e637d04eab3b40392098f2bb12ba",
  "games/fn_split_leave_operation_viva_confirmed.js": "1d63b8e5e5b69dac805cd8c22cafeb5bcd9e25ebb85ecacc1ae27842eb9021e6",
  "games/fn_split_leave_operation_viva_ack.js": "b7d649b24426f52213bb5b9a08bd633162156a379e21ea55591bec8c628ca21e",
  "games/fn_split_leave_game_update.js": "a2ad7eee05e157a2672bd73a54a315205c5a3e14ba8ee4e00c32db0866d8c82d",
  "games/fn_split_leave_game_ack.js": "bc0b101f99f0f8d86e1259915f53a5f79ef847b5225c0f47a3a3a9801202626d",
  "games/fn_split_leave_generation_fence.js": "252dada4eebd2053fd6ab0abfd5efaa83877db81d86c09eb832b6185ea5135f6",
  "games/fn_split_leave_operation_done.js": "e790731745e62541c328b61f0739de23b3fe5a178005b7804ec73b3acde1749f",
  "games/fn_split_leave_operation_done_ack.js": "fb6021a5f13b0edcf15ef866eb55dfc617824fff169a4265862c1ecc211605a5",
  "games/fn_split_leave_operation_done_readback.js": "e10a730fdbd0fad271287c2c46cd3383e2d6ebe08ae2d3d1c5a1ddcdf5c1488f",
  "games/fn_split_leave_finalize.js": "ac1bcdf55f312248d7821c7f9436103d8c9db5c34e84e4ec5e9dcd7c904a4064",
  "games/fn_split_leave_retry_response.js": "73f20298daeeb8a952239d9e9591544fa795e3144129830af73e58732885bd68",
  "games/fn_split_leave_retry_query.js": "0ddc4ef15327b079874be277875f51a4cd831807a6451be566e8b2c1863c1c41",
  "games/fn_split_leave_retry_select.js": "a992603bc6fa816516c208a3e5aa342507e6ceeec326d25da057dec5b435cf77",
  "games/fn_split_leave_retry_claim_ack.js": "8b0d1b2a6c4cf3b2a43bef84a1042abf5ef3dd74139f6f2faf048d7ceb49c493",
  "games/fn_split_leave_retry_hydrate.js": "a5ddd5f07bdf7773901901f532578550036cf2308e67d1b93e6f4d8f5888bc25",
  "chat/fn_chat_auth_prepare.js": "6d2a7b3bd382cc8a34d3c804af5b4b1e86a46872bb68cc814cf0d5e06671a4c0",
  "chat/fn_chat_auth_resolve.js": "1dee9ec49848c2c0658c12789b40cb3b64108e1f0c90141355a25671f09e24a0",
  "chat/fn_chat_post_prepare_secure.js": "efbdee6c44e475bfece1985480ab00119a0e497081daa727ab6343ed986654d0",
  "chat/fn_chat_post_build_insert_secure.js": "0f5b194558d11180ff1e1839da3dfbae0f5fc3ba6268d79ed52317ccfa7fc627",
  "chat/fn_chat_get_prepare_secure.js": "b0be4a44ebb07cff3b18d185e96903258b90c197c3f2f6a01db2f6b58c80e470",
  "chat/fn_chat_get_build_query_secure.js": "198323d304316910e3bb10c18656aa8f15595f47f94368ffc5b7760c972d3a1c",
  "chat/fn_chat_read_prepare_secure.js": "288ae31caa8489cff7db4b1061c955c949f840ed12d5c46f65441531d3eef1cd",
  "chat/fn_chat_read_insert_secure.js": "b857cd067c4ae3c9557d70bae7c499d5b1c478826c13ba72731d7204cef8c3d2",
  "chat/fn_chat_list_prepare_secure.js": "ef2c0b445fdd5c4675e04018f29daf0a379eca516d46fac7a849d4597f89ab7f",
  "chat/fn_chat_list_build_messages_query.js": "491b1e230bfc7ca105414abf12e655b11e689a6cf2382f9fa931543ef9fe9eb6",
  "participants/fn_cache_gate_v2.js": "b4ee19c47bdbacfcea79b3aa91977b30c02e14bedf85f67a7ed0fb5478c85c78",
  "participants/fn_terminal_v2.js": "2772af0a50c4ff0475179020417222d27e7aa296bf48ec2d0cc4e52139019429",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const exactNode = (flow, id, type) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1 || matches[0].type !== type) fail(`Expected exact ${type} node ${id}`);
  return matches[0];
};
const readFn = (fileName) => fs.readFileSync(path.join(FN_DIR, fileName), "utf8");
const readChatFn = (fileName) => fs.readFileSync(path.join(CHAT_FN_DIR, fileName), "utf8");
const readParticipantsFn = (fileName) => fs.readFileSync(path.join(PARTICIPANTS_FN_DIR, fileName), "utf8");
const parseArgs = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
  if (!result["--workspace"] || !result["--output"] || !result["--report"]) {
    fail("Usage: --workspace <live-workspace> --output <candidate.json> --report <report.json> [--rollout-phase phase1-compat|phase2-cas]");
  }
  result["--rollout-phase"] = result["--rollout-phase"] || "phase2-cas";
  if (!["phase1-compat", "phase2-cas"].includes(result["--rollout-phase"])) {
    fail("Unknown rollout phase; expected phase1-compat or phase2-cas");
  }
  return result;
};
const functionNode = (template, id, name, func, outputs, wires, x, y) => ({
  ...structuredClone(template),
  id,
  name,
  func,
  outputs,
  wires,
  x,
  y,
});
const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((field) => !isDeepStrictEqual(before[field], after[field]))
  .sort();

const args = parseArgs(process.argv.slice(2));
const rolloutPhase = args["--rollout-phase"];
const patchCasEnabled = rolloutPhase === "phase2-cas";
for (const [sourceKey, expectedHash] of Object.entries(expectedCandidateSourceHashes)) {
  const [area, fileName] = sourceKey.split("/");
  const source = area === "chat" ? readChatFn(fileName)
    : area === "participants" ? readParticipantsFn(fileName)
      : readFn(fileName);
  if (sha256(source) !== expectedHash) fail(`Candidate source mismatch for ${sourceKey}`);
}
const verified = verifyWorkspace(args["--workspace"], { quiet: true });
if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256) fail("Live flow preimage SHA mismatch");
if (verified.nodeCount !== EXPECTED_NODE_COUNT) fail("Live flow node count mismatch");
const flow = structuredClone(verified.source);
if (flow.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
  fail("Live flow HTTP route count mismatch");
}
const tab = exactNode(flow, TAB_ID, "tab");
if (tab.label !== "LK Games" || tab.disabled !== false) fail("LK Games tab contract mismatch");
const before = structuredClone(flow);

const httpIn = exactNode(flow, ids.httpIn, "http in");
if (httpIn.url !== "/lk/games/:gameId/split/leave" || httpIn.method !== "post") {
  fail("Split leave route contract mismatch");
}
const auth = exactNode(flow, ids.auth, "function");
const actor = exactNode(flow, ids.actor, "function");
const prepare = exactNode(flow, ids.prepare, "function");
const authorize = exactNode(flow, ids.authorize, "function");
const router = exactNode(flow, ids.router, "function");
const participantsGate = exactNode(flow, ids.participantsGate, "function");
const participantsTerminal = exactNode(flow, ids.participantsTerminal, "function");
const listNormalize = exactNode(flow, ids.listNormalize, "function");
const chatSendPrepare = exactNode(flow, ids.chatSendPrepare, "function");
const chatSendBuild = exactNode(flow, ids.chatSendBuild, "function");
const chatGetPrepare = exactNode(flow, ids.chatGetPrepare, "function");
const chatGetBuild = exactNode(flow, ids.chatGetBuild, "function");
const chatReadPrepare = exactNode(flow, ids.chatReadPrepare, "function");
const chatReadBuild = exactNode(flow, ids.chatReadBuild, "function");
const chatListPrepare = exactNode(flow, ids.chatListPrepare, "function");
const patchPrepare = exactNode(flow, ids.patchPrepare, "function");
const patchArgs = exactNode(flow, ids.patchArgs, "function");
for (const node of [
  auth, actor, prepare, authorize, router, participantsGate, participantsTerminal, listNormalize,
  chatSendPrepare, chatSendBuild, chatGetPrepare, chatGetBuild, chatReadPrepare, chatReadBuild,
  chatListPrepare, patchPrepare, patchArgs,
]) {
  if (sha256(String(node.func || "")) !== expectedFunctionHashes[node.id]) {
    fail(`Function preimage mismatch for ${node.id}`);
  }
}
exactNode(flow, ids.profileHttp, "http request");
exactNode(flow, ids.gameFind, "mongodb4");
exactNode(flow, ids.vivaHttp, "http request");
exactNode(flow, ids.response, "http response");
exactNode(flow, ids.debug, "debug");
const chatRoutes = [
  [ids.chatSendRoute, "/lk/games/:gameId/chat/messages", "post"],
  [ids.chatGetRoute, "/lk/games/:gameId/chat/messages", "get"],
  [ids.chatReadRoute, "/lk/games/:gameId/chat/read", "post"],
  [ids.chatListRoute, "/lk/chats/by-phone", "get"],
].map(([id, url, method]) => {
  const node = exactNode(flow, id, "http in");
  if (node.url !== url || node.method !== method) fail(`Chat route contract mismatch for ${id}`);
  return node;
});
const patchRoutes = [ids.patchRoute, ids.patchRecordsRoute].map((id) => exactNode(flow, id, "http in"));
if (patchRoutes[0].url !== "/lk/games/:gameId" || patchRoutes[1].url !== "/lk/games/records/:gameId") {
  fail("PATCH route contract mismatch");
}
const patchMongo = exactNode(flow, ids.patchMongo, "mongodb4");
const patchResponse = exactNode(flow, ids.patchResponse, "http response");
const patchDebug = exactNode(flow, ids.patchDebug, "debug");
const patchAutojoin = exactNode(flow, ids.patchAutojoin, "mongodb4");
const chatListFindMessages = exactNode(flow, ids.chatListFindMessages, "mongodb4");
const chatListResponse = exactNode(flow, ids.chatListResponse, "http response");
const chatListDebug = exactNode(flow, ids.chatListDebug, "debug");

prepare.func = readFn("fn_split_leave_prepare.js");
authorize.func = readFn("fn_split_leave_authorize.js");
authorize.outputs = 5;
authorize.wires = [[ids.operationStartBuild], [ids.response], [ids.debug], [ids.router], [ids.operationFind]];
router.func = readFn("fn_split_leave_router.js");
router.outputs = 5;
router.wires = [[ids.vivaHttp], [ids.response], [ids.debug], [ids.operationVivaBuild], [ids.operationStartBuild]];
participantsGate.func = readParticipantsFn("fn_cache_gate_v2.js");
participantsTerminal.func = readParticipantsFn("fn_terminal_v2.js");
listNormalize.func = readFn("fn_list_normalize.js");

for (const route of chatRoutes) route.wires = [[ids.chatAuthPrepare]];
chatSendPrepare.func = readChatFn("fn_chat_post_prepare_secure.js");
chatSendBuild.func = readChatFn("fn_chat_post_build_insert_secure.js");
chatGetPrepare.func = readChatFn("fn_chat_get_prepare_secure.js");
chatGetBuild.func = readChatFn("fn_chat_get_build_query_secure.js");
chatReadPrepare.func = readChatFn("fn_chat_read_prepare_secure.js");
chatReadBuild.func = readChatFn("fn_chat_read_insert_secure.js");
chatListPrepare.func = readChatFn("fn_chat_list_prepare_secure.js");
chatListPrepare.wires = [[ids.chatListFindGames], [ids.chatListResponse], [ids.chatListDebug]];

if (patchCasEnabled) {
  for (const route of patchRoutes) route.wires = [[ids.patchCasGuard]];
  patchPrepare.wires = [[ids.patchArgs], [ids.patchResponseGate], [ids.patchDebug], [ids.patchAutojoinGate]];
  patchArgs.wires = [[ids.patchCasQuery]];
  patchMongo.wires = [[ids.patchAfterWrite]];
}

const functionTemplate = router;
const gameMongoTemplate = exactNode(flow, "591234d213742276", "mongodb4");
const chatMongoTemplate = exactNode(flow, "d323b4a2bc150c16", "mongodb4");
const findMongoTemplate = exactNode(flow, ids.gameFind, "mongodb4");
const profileHttpTemplate = exactNode(flow, ids.profileHttp, "http request");
const operationUpdate = (id, name, wires, x, y) => ({
  ...structuredClone(gameMongoTemplate),
  id,
  name,
  collection: "lk_game_leave_operations",
  operation: "updateOne",
  x,
  y,
  wires,
});
const operationFind = (id, name, wires, x, y) => ({
  ...structuredClone(findMongoTemplate),
  id,
  name,
  collection: "lk_game_leave_operations",
  operation: "find",
  x,
  y,
  wires,
});
const allNewNodes = [
  functionNode(functionTemplate, ids.operationStartBuild, "Build durable split leave operation", readFn("fn_split_leave_operation_start.js"), 2, [[ids.operationStartUpdate], [ids.response]], 2140, 1240),
  operationUpdate(ids.operationStartUpdate, "Upsert durable split leave operation", [[ids.operationFindBuild]], 2380, 1240),
  functionNode(functionTemplate, ids.operationFindBuild, "Build durable operation read", readFn("fn_split_leave_operation_find.js"), 2, [[ids.operationFind], [ids.response]], 2640, 1240),
  operationFind(ids.operationFind, "Read durable split leave operation", [[ids.operationRoute]], 2880, 1240),
  functionNode(functionTemplate, ids.operationRoute, "Route durable split leave operation", readFn("fn_split_leave_operation_route.js"), 4, [[ids.router], [ids.operationVivaBuild], [ids.response], [ids.operationClaimBuild]], 3140, 1240),
  functionNode(functionTemplate, ids.operationClaimBuild, "Claim stale split leave operation", readFn("fn_split_leave_operation_claim.js"), 2, [[ids.operationClaimUpdate], [ids.response]], 3380, 1180),
  operationUpdate(ids.operationClaimUpdate, "Update stale split leave claim", [[ids.operationClaimAck]], 3620, 1180),
  functionNode(functionTemplate, ids.operationClaimAck, "Acknowledge split leave claim", readFn("fn_split_leave_operation_claim_ack.js"), 2, [[ids.router], [ids.response]], 3860, 1180),
  functionNode(functionTemplate, ids.operationVivaBuild, "Persist Viva-confirmed split leave", readFn("fn_split_leave_operation_viva_confirmed.js"), 2, [[ids.operationVivaUpdate], [ids.retry]], 3380, 1320),
  operationUpdate(ids.operationVivaUpdate, "Update split leave to Viva confirmed", [[ids.operationVivaAck]], 3620, 1320),
  functionNode(functionTemplate, ids.operationVivaAck, "Acknowledge Viva-confirmed state", readFn("fn_split_leave_operation_viva_ack.js"), 3, [[ids.gameBuild], [ids.retry], [ids.operationDoneBuild]], 3860, 1320),
  functionNode(functionTemplate, ids.gameBuild, "Build split leave game CAS", readFn("fn_split_leave_game_update.js"), 3, [[ids.gameUpdate], [ids.retry], [ids.retry]], 4100, 1400),
  { ...structuredClone(gameMongoTemplate), id: ids.gameUpdate, name: "Apply split leave game CAS", operation: "updateOne", x: 4340, y: 1360, wires: [[ids.gameAck]] },
  functionNode(functionTemplate, ids.gameAck, "Acknowledge split leave game CAS", readFn("fn_split_leave_game_ack.js"), 2, [[ids.generationFenceFind], [ids.retry]], 4580, 1360),
  { ...structuredClone(findMongoTemplate), id: ids.generationFenceFind, name: "Read fresh game generation after leave CAS", x: 4820, y: 1360, wires: [[ids.generationFence]] },
  functionNode(functionTemplate, ids.generationFence, "Fence rejoin generation after leave CAS", readFn("fn_split_leave_generation_fence.js"), 2, [[ids.operationDoneBuild], [ids.retry]], 5060, 1360),
  functionNode(functionTemplate, ids.operationDoneBuild, "Persist split leave LK applied and done", readFn("fn_split_leave_operation_done.js"), 2, [[ids.operationDoneUpdate], [ids.retry]], 5060, 1400),
  operationUpdate(ids.operationDoneUpdate, "Update split leave operation to done", [[ids.operationDoneAck]], 5300, 1360),
  functionNode(functionTemplate, ids.operationDoneAck, "Acknowledge split leave done", readFn("fn_split_leave_operation_done_ack.js"), 3, [[ids.finalize], [ids.operationDoneFind], [ids.retry]], 5540, 1360),
  operationFind(ids.operationDoneFind, "Read back split leave done", [[ids.operationDoneReadback]], 5780, 1400),
  functionNode(functionTemplate, ids.operationDoneReadback, "Verify split leave done readback", readFn("fn_split_leave_operation_done_readback.js"), 2, [[ids.finalize], [ids.retry]], 6020, 1400),
  functionNode(functionTemplate, ids.finalize, "Finalize split leave consistency", readFn("fn_split_leave_finalize.js"), 2, [[ids.response], [ids.debug]], 6260, 1360),
  functionNode(functionTemplate, ids.retry, "Split leave retry-required response", readFn("fn_split_leave_retry_response.js"), 2, [[ids.response], [ids.debug]], 5060, 1500),
  {
    id: ids.persistenceCatch,
    type: "catch",
    z: TAB_ID,
    name: "Catch split leave persistence errors",
    scope: [
      ids.operationStartUpdate,
      ids.operationClaimUpdate,
      ids.operationVivaUpdate,
      ids.gameUpdate,
      ids.generationFenceFind,
      ids.operationDoneUpdate,
      ids.operationDoneFind,
      ids.retryClaimUpdate,
    ],
    uncaught: false,
    x: 4580,
    y: 1580,
    wires: [[ids.retry]],
  },
  {
    id: ids.retryInject,
    type: "inject",
    z: TAB_ID,
    name: "Retry Viva-confirmed split leaves",
    props: [{ p: "payload" }, { p: "topic", vt: "str" }],
    repeat: "120",
    crontab: "",
    once: false,
    onceDelay: 0.1,
    topic: "",
    payload: "",
    payloadType: "date",
    x: 2140,
    y: 1660,
    wires: [[ids.retryQuery]],
  },
  functionNode(functionTemplate, ids.retryQuery, "Build Viva-confirmed retry query", readFn("fn_split_leave_retry_query.js"), 1, [[ids.retryOperationFind]], 2400, 1660),
  operationFind(ids.retryOperationFind, "Find Viva-confirmed split leave retries", [[ids.retrySelect]], 2660, 1660),
  functionNode(functionTemplate, ids.retrySelect, "Claim Viva-confirmed split leave retry", readFn("fn_split_leave_retry_select.js"), 2, [[ids.retryClaimUpdate], [ids.debug]], 2920, 1660),
  operationUpdate(ids.retryClaimUpdate, "Update split leave retry claim", [[ids.retryClaimAck]], 3180, 1660),
  functionNode(functionTemplate, ids.retryClaimAck, "Acknowledge split leave retry claim", readFn("fn_split_leave_retry_claim_ack.js"), 2, [[ids.retryGameFind], [ids.debug]], 3440, 1660),
  { ...structuredClone(findMongoTemplate), id: ids.retryGameFind, name: "Find game for split leave retry", x: 3700, y: 1660, wires: [[ids.retryHydrate]] },
  functionNode(functionTemplate, ids.retryHydrate, "Hydrate split leave background retry", readFn("fn_split_leave_retry_hydrate.js"), 4, [[ids.gameBuild], [ids.router], [ids.debug], [ids.operationDoneBuild]], 3960, 1660),
  functionNode(functionTemplate, ids.chatAuthPrepare, "Authenticate chat Bearer", readChatFn("fn_chat_auth_prepare.js"), 3, [[ids.chatAuthProfile], [ids.chatAuthResponse], [ids.chatAuthDebug]], 520, 2080),
  { ...structuredClone(profileHttpTemplate), id: ids.chatAuthProfile, name: "Resolve chat actor profile", x: 760, y: 2080, wires: [[ids.chatAuthResolve]] },
  functionNode(functionTemplate, ids.chatAuthResolve, "Authorize verified chat actor", readChatFn("fn_chat_auth_resolve.js"), 6, [
    [ids.chatSendPrepare], [ids.chatGetPrepare], [ids.chatReadPrepare], [ids.chatListPrepare], [ids.chatAuthResponse], [ids.chatAuthDebug],
  ], 1000, 2080),
  { ...structuredClone(chatListResponse), id: ids.chatAuthResponse, name: "Chat auth response", x: 1240, y: 2140, wires: [] },
  { ...structuredClone(chatListDebug), id: ids.chatAuthDebug, name: "Chat auth debug", x: 1240, y: 2200, wires: [] },
  { ...structuredClone(findMongoTemplate), id: ids.chatListFindGames, name: "Find active games for verified chat actor", collection: "lk_games", operation: "find", x: 1480, y: 2080, wires: [[ids.chatListBuild]] },
  functionNode(functionTemplate, ids.chatListBuild, "Build verified chat list query", readChatFn("fn_chat_list_build_messages_query.js"), 3, [
    [ids.chatListFindMessages], [ids.chatListResponse], [ids.chatListDebug],
  ], 1720, 2080),
  functionNode(functionTemplate, ids.patchCasGuard, "Require game PATCH CAS", readFn("fn_patch_cas_guard.js"), 3, [
    [ids.patchPrepare], [ids.patchResponse], [ids.patchDebug],
  ], 520, 2320),
  functionNode(functionTemplate, ids.patchResponseGate, "Gate pre-CAS PATCH response", readFn("fn_patch_response_gate.js"), 1, [[ids.patchResponse]], 1000, 2360),
  functionNode(functionTemplate, ids.patchAutojoinGate, "Gate pre-CAS PATCH autojoin", readFn("fn_patch_autojoin_gate.js"), 1, [[ids.patchAutojoin]], 1000, 2420),
  functionNode(functionTemplate, ids.patchCasQuery, "Bind game PATCH CAS query", readFn("fn_patch_cas_query.js"), 1, [[ids.patchMongo]], 1240, 2320),
  functionNode(functionTemplate, ids.patchAfterWrite, "Acknowledge game PATCH CAS", readFn("fn_patch_after_write.js"), 3, [
    [ids.patchResponse], [ids.patchDebug], [ids.patchAutojoin],
  ], 1480, 2320),
  {
    id: ids.patchCatch,
    type: "catch",
    z: TAB_ID,
    name: "Catch game PATCH CAS write errors",
    scope: [ids.patchMongo],
    uncaught: false,
    x: 1240,
    y: 2480,
    wires: [[ids.patchAfterWrite]],
  },
];
const patchCasNodeIds = new Set([
  ids.patchCasGuard,
  ids.patchResponseGate,
  ids.patchAutojoinGate,
  ids.patchCasQuery,
  ids.patchAfterWrite,
  ids.patchCatch,
]);
const newNodes = patchCasEnabled
  ? allNewNodes
  : allNewNodes.filter((node) => !patchCasNodeIds.has(node.id));
for (const node of newNodes) {
  if (flow.some((current) => current.id === node.id)) fail(`New node id already exists: ${node.id}`);
  flow.push(node);
}

const byId = new Map(flow.map((node) => [node.id, node]));
const exactWires = (id, expected) => {
  const actual = byId.get(id)?.wires;
  if (!isDeepStrictEqual(actual, expected)) fail(`Wire contract mismatch for ${id}`);
};
for (const node of flow) {
  for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
    if (!byId.has(targetId)) fail(`Broken wire ${node.id} -> ${targetId}`);
  }
  if (node.type === "function" && Number.isInteger(node.outputs)
    && Array.isArray(node.wires) && node.wires.length !== node.outputs) {
    fail(`Function output/wire count mismatch for ${node.id}`);
  }
}
for (const routeId of [ids.chatSendRoute, ids.chatGetRoute, ids.chatReadRoute, ids.chatListRoute]) {
  exactWires(routeId, [[ids.chatAuthPrepare]]);
}
exactWires(ids.chatAuthPrepare, [[ids.chatAuthProfile], [ids.chatAuthResponse], [ids.chatAuthDebug]]);
exactWires(ids.chatAuthProfile, [[ids.chatAuthResolve]]);
exactWires(ids.chatAuthResolve, [
  [ids.chatSendPrepare], [ids.chatGetPrepare], [ids.chatReadPrepare], [ids.chatListPrepare],
  [ids.chatAuthResponse], [ids.chatAuthDebug],
]);
exactWires(ids.chatListPrepare, [[ids.chatListFindGames], [ids.chatListResponse], [ids.chatListDebug]]);
exactWires(ids.chatListFindGames, [[ids.chatListBuild]]);
exactWires(ids.chatListBuild, [[ids.chatListFindMessages], [ids.chatListResponse], [ids.chatListDebug]]);

if (patchCasEnabled) {
  for (const routeId of [ids.patchRoute, ids.patchRecordsRoute]) exactWires(routeId, [[ids.patchCasGuard]]);
  exactWires(ids.patchCasGuard, [[ids.patchPrepare], [ids.patchResponse], [ids.patchDebug]]);
  exactWires(ids.patchPrepare, [[ids.patchArgs], [ids.patchResponseGate], [ids.patchDebug], [ids.patchAutojoinGate]]);
  exactWires(ids.patchArgs, [[ids.patchCasQuery]]);
  exactWires(ids.patchCasQuery, [[ids.patchMongo]]);
  exactWires(ids.patchMongo, [[ids.patchAfterWrite]]);
  exactWires(ids.patchAfterWrite, [[ids.patchResponse], [ids.patchDebug], [ids.patchAutojoin]]);
} else if ([...patchCasNodeIds].some((id) => byId.has(id))) {
  fail("Phase-one compatibility candidate must not contain PATCH CAS nodes");
}

exactWires(ids.authorize, [[ids.operationStartBuild], [ids.response], [ids.debug], [ids.router], [ids.operationFind]]);
exactWires(ids.router, [[ids.vivaHttp], [ids.response], [ids.debug], [ids.operationVivaBuild], [ids.operationStartBuild]]);
exactWires(ids.operationVivaAck, [[ids.gameBuild], [ids.retry], [ids.operationDoneBuild]]);
exactWires(ids.gameBuild, [[ids.gameUpdate], [ids.retry], [ids.retry]]);
exactWires(ids.gameUpdate, [[ids.gameAck]]);
exactWires(ids.gameAck, [[ids.generationFenceFind], [ids.retry]]);
exactWires(ids.generationFenceFind, [[ids.generationFence]]);
exactWires(ids.generationFence, [[ids.operationDoneBuild], [ids.retry]]);
exactWires(ids.retryHydrate, [[ids.gameBuild], [ids.router], [ids.debug], [ids.operationDoneBuild]]);
if (byId.has(ids.chatUpdate) || byId.has(ids.chatAck)) {
  fail("Destructive chat cleanup must not be part of the leave candidate graph");
}

for (const source of [prepare.func, authorize.func, router.func]) {
  if (/grant_type=password|password=|username=/i.test(source)) {
    fail("Split leave source contains a hardcoded service credential path");
  }
}
const idsAfter = flow.map((node) => node.id);
if (new Set(idsAfter).size !== idsAfter.length) fail("Candidate contains duplicate node ids");
if (flow.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
  fail("Candidate changed HTTP routes");
}
const changes = flow.flatMap((node) => {
  const previous = before.find((item) => item.id === node.id);
  if (!previous) return [{ id: node.id, kind: "added", changedFields: Object.keys(node).sort() }];
  if (isDeepStrictEqual(previous, node)) return [];
  return [{ id: node.id, kind: "changed", changedFields: changedFields(previous, node) }];
});
const allowedExisting = new Map([
  [ids.prepare, ["func"]],
  [ids.authorize, ["func", "outputs", "wires"]],
  [ids.router, ["func", "outputs", "wires"]],
  [ids.participantsGate, ["func"]],
  [ids.participantsTerminal, ["func"]],
  [ids.listNormalize, ["func"]],
  [ids.chatSendRoute, ["wires"]],
  [ids.chatGetRoute, ["wires"]],
  [ids.chatReadRoute, ["wires"]],
  [ids.chatListRoute, ["wires"]],
  [ids.chatSendPrepare, ["func"]],
  [ids.chatSendBuild, ["func"]],
  [ids.chatGetPrepare, ["func"]],
  [ids.chatGetBuild, ["func"]],
  [ids.chatReadPrepare, ["func"]],
  [ids.chatReadBuild, ["func"]],
  [ids.chatListPrepare, ["func", "wires"]],
  [ids.patchRoute, ["wires"]],
  [ids.patchRecordsRoute, ["wires"]],
  [ids.patchPrepare, ["wires"]],
  [ids.patchArgs, ["wires"]],
  [ids.patchMongo, ["wires"]],
]);
for (const change of changes.filter((item) => item.kind === "changed")) {
  if (!isDeepStrictEqual(change.changedFields, allowedExisting.get(change.id))) {
    fail(`Unexpected existing-node change for ${change.id}: ${change.changedFields.join(",")}`);
  }
}

const outputPath = path.resolve(args["--output"]);
const reportPath = path.resolve(args["--report"]);
for (const target of [outputPath, reportPath]) {
  if (fs.existsSync(target)) fail(`Refusing to overwrite ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
}
const outputText = `${JSON.stringify(flow, null, 2)}\n`;
fs.writeFileSync(outputPath, outputText, { mode: 0o600, flag: "wx" });
const report = {
  rolloutPhase,
  sourceSha256: verified.sourceSha256,
  candidateSha256: sha256(outputText),
  sourceNodeCount: before.length,
  candidateNodeCount: flow.length,
  httpRouteCount: EXPECTED_ROUTE_COUNT,
  changes,
  sourceFunctionContracts: Object.keys(expectedCandidateSourceHashes).length,
  graphContract: {
    chatBearerProfileGate: true,
    patchCasAcknowledgementGate: patchCasEnabled,
    exactReferenceDedupeByDocumentId: true,
    durableLeaveSaga: true,
    gameCasBeforeFreshGenerationFence: true,
    destructiveChatCleanup: false,
    historicalChatRelatedPhonesAuthoritative: false,
  },
  deploymentPerformed: false,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(report));

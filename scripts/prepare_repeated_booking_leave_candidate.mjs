import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TARGETS = Object.freeze([
  {
    "id": "7c280001a0c1e015",
    "file": "fn_split_leave_authorize.js",
    "beforeSha256": "b819ad5b498671223b701067725b9cf8cc59f0a9c1b5722f3ef30de5437e33b4"
  },
  {
    "id": "lk_staff_player_leave_prepare_20260812",
    "file": "fn_staff_player_leave_prepare.js",
    "beforeSha256": "302b4c2982e72d3253930cf1fedffa1c6a35a8464d21698fb9306a0c9c441b80"
  },
  {
    "id": "lk_staff_player_leave_authorize_20260812",
    "file": "fn_staff_player_leave_authorize.js",
    "beforeSha256": "21b49b991112ec559295a9ce5764a33ee70b324e660490948b91bfacdf98241d"
  },
  {
    "id": "lk_split_leave_operation_start_build_20260801",
    "file": "fn_split_leave_operation_start.js",
    "beforeSha256": "8e38fcb72ddc20628a18a7b8e781dbf35c5d57626eddc7ddbbffbaba84df96da"
  },
  {
    "id": "lk_split_leave_operation_route_20260801",
    "file": "fn_split_leave_operation_route.js",
    "beforeSha256": "5423efb34fbebe8a0c03f22f4ab53a3e99c18c8df593ff014d5fb311e2af05f6"
  },
  {
    "id": "9878400d518ebcbd",
    "file": "fn_split_leave_router.js",
    "beforeSha256": "4411495cc679ddde0724f8eda9aa1dcf8c06dcca1adf276df65422438b14d7c3"
  },
  {
    "id": "lk_split_leave_retry_select_20260801",
    "file": "fn_split_leave_retry_select.js",
    "beforeSha256": "1fd8dafababbfe2c939b144d007c7df7a8e2e919e99c612be9ca6996c998a38f"
  },
  {
    "id": "lk_split_leave_retry_hydrate_20260801",
    "file": "fn_split_leave_retry_hydrate.js",
    "beforeSha256": "30e4ced1b3187a0a8cf6762039188b8b28d42dadefc1461cc631f898140245d2"
  },
  {
    "id": "lk_split_leave_game_update_build_20260801",
    "file": "fn_split_leave_game_update.js",
    "beforeSha256": "2f2d344707652ad5dbf0d120d648eb7bc8f1e1a1194f24749f43973fc674a9b9"
  }
]);
export const IDS = Object.freeze({ router: "9878400d518ebcbd", update: "lk_split_leave_operation_start_update_20260801",
  route: "lk_split_leave_operation_route_20260801", find: "lk_split_leave_operation_find_20260801", response: "35f7c89069fc393a",
  bind: "lk_staff_leave_discovery_bind_20260913", persist: "lk_staff_leave_discovery_update_20260913",
  ack: "lk_staff_leave_discovery_ack_20260913", caught: "lk_staff_leave_discovery_catch_20260913" });
export const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const read = (file) => fs.readFileSync(path.join(ROOT, "nodered_games_nodes", file), "utf8");

// Source-only composition. CLI never accepts alternate preimage pins. The optional
// pins seam is used solely by synthetic graph tests, not release validation.
export function buildRepeatedBookingLeaveCandidate(source, pins = TARGETS) {
  if (!Array.isArray(source)) throw new Error("Flow must be an array");
  const result = structuredClone(source);
  const ids = new Set();
  for (const node of result) {
    if (!node.id || ids.has(node.id)) throw new Error("Duplicate or missing node ID");
    ids.add(node.id);
  }
  const exact = (id, type) => {
    const node = result.find((item) => item.id === id);
    if (!node || node.type !== type || node.d === true || node.disabled === true) throw new Error(`Node contract mismatch: ${id}`);
    return node;
  };
  const router = exact(IDS.router, "function");
  if (router.outputs !== 5 || router.wires?.length !== 5) throw new Error("Router topology drift");
  const update = exact(IDS.update, "mongodb4");
  const find = exact(IDS.find, "mongodb4");
  exact(IDS.response, "http response");
  if (update.operation !== "updateOne" || find.operation !== "find"
    || update.collection !== "lk_game_leave_operations" || find.collection !== update.collection
    || !update.server || find.server !== update.server
    || JSON.stringify(find.wires) !== JSON.stringify([[IDS.route]])
    || update.z !== router.z || find.z !== router.z) throw new Error("Operation database contract mismatch");
  for (const target of pins) {
    const node = exact(target.id, "function");
    if (node.z !== router.z || hash(node.func) !== target.beforeSha256) throw new Error(`Preimage drift: ${target.id}`);
    if (node.wires?.length !== node.outputs) throw new Error("Function output mismatch");
    const body = read(target.file);
    new vm.Script(`(function(msg,global,flow,env){${body}\n})`);
    node.func = body;
  }
  for (const id of [IDS.bind, IDS.persist, IDS.ack, IDS.caught]) if (ids.has(id)) throw new Error("Discovery graph already exists");
  router.outputs = 6;
  router.wires.push([IDS.bind]);
  const fn = (id, name, file, wires) => {
    const func = read(file);
    new vm.Script(`(function(msg,global,flow,env){${func}\n})`);
    return { ...structuredClone(router), id, name, func, outputs: wires.length, wires };
  };
  result.push(
    fn(IDS.bind, "Bind discovered staff booking", "fn_staff_leave_discovery_bind.js", [[IDS.persist], [IDS.response]]),
    { ...structuredClone(update), id: IDS.persist, name: "Persist discovered staff booking", wires: [[IDS.ack]] },
    fn(IDS.ack, "Verify discovered booking persistence", "fn_staff_leave_discovery_ack.js", [[IDS.find], [IDS.response]]),
    { id: IDS.caught, type: "catch", z: router.z, name: "Catch discovery persistence failure", scope: [IDS.persist], uncaught: false, wires: [[IDS.ack]] }
  );
  for (const node of result) for (const wire of node.wires || []) for (const id of wire) {
    if (!result.some((target) => target.id === id)) throw new Error(`Dangling wire: ${id}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output) || input === output) {
    throw new Error("Usage: node prepare_repeated_booking_leave_candidate.mjs /absolute/source.json /absolute/new-candidate.json");
  }
  const candidate = buildRepeatedBookingLeaveCandidate(JSON.parse(fs.readFileSync(input, "utf8")));
  fs.writeFileSync(output, JSON.stringify(candidate), { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ candidateSha256: hash(JSON.stringify(candidate)), nodes: candidate.length, liveWrites: 0 }));
}

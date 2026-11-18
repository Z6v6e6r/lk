import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { assertFlowArray, verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { patchTournamentSubscriptionGateway, tournamentCheckoutSource } from "./lib/tournamentCheckoutSources.mjs";

export const SUBSCRIPTION_ROUTER_ID = "lk_subscription_booking_router_20260804";
const SUBSCRIPTION_FIND_ID = "lk_subscription_booking_find_20260804";
export const CHECKOUT_ROUTE = "/lk/tournament-checkouts";
const DEPLOYMENT_ID = "lk1-tournament-checkout-v1";
const sha = value => createHash("sha256").update(value).digest("hex");

function checkoutNodes(z, clientNode, collection) {
  const id = name => DEPLOYMENT_ID + ":" + name;
  const link = name => [id(name)];
  const node = (name, type, fields, wires = []) => ({
    id: id(name), z, type, name: "LK1 tournament checkout " + name, x: 980, y: 6000, wires, ...fields,
  });
  const fn = (name, func, wires) => node(name, "function",
    { func, outputs: wires.length, noerr: 0, initialize: "", finalize: "", libs: [] }, wires);
  const mongo = (name, operation) => node(name, "mongodb4", {
    collection, operation, clientNode,
    mode: "collection", output: "toArray", maxTimeMS: "5000", handleDocId: false,
  }, [link("router")]);
  return [
    node("post", "http in", { url: CHECKOUT_ROUTE, method: "post", upload: false }, [link("entry")]),
    fn("entry", "delete msg._lkTournamentCheckout; return msg;", [link("router")]),
    fn("router", tournamentCheckoutSource(), ["http", "find", "insert", "update", "response"].map(link)),
    node("http", "http request", { method: "use", ret: "obj", paytoqs: "ignore", url: "",
      requestTimeout: "10000", senderr: true, persist: false, authType: "", insecureHTTPParser: false }, [link("router")]),
    mongo("find", "find"),
    mongo("insert", "insertOne"),
    mongo("update", "updateOne"),
    node("response", "http response", { statusCode: "", headers: {} }),
    node("catch", "catch", { scope: ["find", "insert", "update", "http"].map(id), uncaught: false }, [link("router")]),
  ];
}

export function composeTournamentCheckoutCandidate(raw, expectedSourceSha, expectedSubscriptionSha) {
  if (sha(raw) !== expectedSourceSha) throw new Error("Tournament checkout source SHA drift");
  const flow = JSON.parse(raw);
  assertFlowArray(flow, "Tournament checkout source");
  const router = flow.find(node => node.id === SUBSCRIPTION_ROUTER_ID);
  const find = flow.find(node => node.id === SUBSCRIPTION_FIND_ID);
  const tab = flow.find(node => node.id === router?.z);
  if (router?.type !== "function" || router.d === true || router.disabled === true
    || sha(router.func || "") !== expectedSubscriptionSha || ![7, 8].includes(router.outputs)
    || router.wires?.length !== router.outputs || tab?.type !== "tab" || tab.disabled === true
    || find?.type !== "mongodb4" || find.operation !== "find" || find.z !== router.z
    || !flow.some(node => node.id === find.clientNode && node.type === "mongodb4-client")) {
    throw new Error("Tournament checkout subscription or Mongo topology drift");
  }
  const mongoOperations = ["find", "insertOne", "updateOne"];
  const collection = find.collection;
  if (typeof collection !== "string" || !collection || mongoOperations.some((operation, i) => {
    const wire = router.wires[i + 1];
    const node = flow.find(item => item.id === wire?.[0]);
    return wire?.length !== 1 || node?.type !== "mongodb4" || node.operation !== operation
      || node.collection !== collection || node.clientNode !== find.clientNode || node.z !== router.z
      || node.disabled === true || node.d === true || !node.wires?.some(outputs => outputs.includes(router.id));
  })) throw new Error("Tournament enrollment must use the same Mongo collection on both paths");
  if (flow.some(node => node.id.startsWith(DEPLOYMENT_ID + ":") || (node.type === "http in" && node.url === CHECKOUT_ROUTE))) {
    throw new Error("Tournament checkout route already installed");
  }
  router.func = patchTournamentSubscriptionGateway(router.func);
  const added = checkoutNodes(router.z, find.clientNode, collection);
  flow.push(...added);
  assertFlowArray(flow, "Tournament checkout candidate");
  for (const fn of [router, ...added.filter(node => node.type === "function")]) {
    new Function("msg", "global", "node", "env", fn.func);
  }
  const bytes = Buffer.from(JSON.stringify(flow, null, 2) + "\n");
  const contract = buildExactGraphContract({ liveBytes: raw, candidateBytes: bytes, deploymentId: DEPLOYMENT_ID,
    allowedChanges: [{ id: router.id, fields: ["func"] }], allowedAdditionIds: added.map(node => node.id) });
  validateReviewedFlowContract({ liveBytes: raw, candidateBytes: bytes, contract, deploymentId: DEPLOYMENT_ID });
  return { bytes, contract };
}

function writeCandidate(workspace, output, expectedSource, expectedRouter) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (!path.isAbsolute(output || "") || path.resolve(output) !== output || fs.existsSync(output)
    || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error("Use a new canonical external directory");
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: path.dirname(output), stdio: "pipe" });
    throw new Error("Raw flow artifacts must stay outside Git");
  } catch (error) {
    if (error.status !== 128 || !String(error.stderr).includes("not a git repository")) throw error;
  }
  const result = composeTournamentCheckoutCandidate(fs.readFileSync(verified.sourcePath), expectedSource, expectedRouter);
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, "candidate.flow.json"), result.bytes, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(output, "exact-graph-contract.json"), JSON.stringify(result.contract, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  return { sourceSha256: expectedSource, candidateSha256: sha(result.bytes), liveMutation: false };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 6) throw new Error("Usage: workspace new-external-output expected-source-sha expected-router-sha");
  console.log(JSON.stringify(writeCandidate(...process.argv.slice(2))));
}

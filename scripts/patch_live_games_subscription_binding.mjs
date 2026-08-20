#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFocusedSubscriptionReturnCandidate } from "./patch_live_games_subscription_return_verification.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const TAB_ID = "4b91e2a2413688db";
export const SUBSCRIPTION_BINDING_LIVE_CONTRACT = Object.freeze({
  sourceSha256: "2cbb00db7983248b212fcd2fc227795277a4d90b7dd3ace804655829a68f3828",
  nodeCount: 4756,
  httpInputCount: 215,
});

export const SUBSCRIPTION_BINDING_TARGETS = Object.freeze([
  ["e92e68bf3f08a70c", "Prepare split join payment", "fn_split_join_prepare.js", 4, "acb2a2eb981f497681d592f257b1c69275da4c9de5307d69654d27980689a149", "003bafe6a0fcdae03f1fcc6cfb1bb8392984e4d8cb880fc6fa884a45bc89e028"],
  ["8f7bd5b482fe9763", "Route Viva split payment", "fn_split_router.js", 5, "34ba99f50ca025095d464aadd47af0aa1352a1679482f032abc30846b5fa1c80", "2e16ee303fcae77e0d09f2a527d0fd77378bc8ea6af4027ef9636ebf8f36813f"],
  ["legacy_payment_confirm_canonical_prepare_20260816", "Forward verified payment to canonical roster", "fn_legacy_payment_confirm_to_canonical.js", 2, "daf1dbe353610ab98504321530229f5c72f7da9fde6cdc6b3d4f7505e76e96ba", "f022be0ba44ab4dd90a739a739d8da91996dcb21fb0c42dcbf36ba01ac909647"],
  ["legacy_roster_bridge_build_20260816", "Build canonical roster projection CAS", "fn_legacy_roster_projection_build.js", 3, "7bd6681ea4edacce543fd7b2d1e289c2be331fae9a00220a756405598f988284", "a55ba88590866f93e7ebc7b432a00435acf022f463a1c8b6bd007f374e0e13b0"],
  ["7c280001a0c1e015", "Authorize split leave booking targets", "fn_split_leave_authorize.js", 5, "fc094bb87e77f41f2a8e4b02eaaf93430074e99ba7a3bfbe556f12c651a3e00b", "c012028a32628f8ecd0154c53582001abdae4e9fb71e3bdb67c53fbeb5a7a2d9"],
  ["9878400d518ebcbd", "Route split leave booking cancel", "fn_split_leave_router.js", 5, "fcf80d9a7b44ff6850013991f4bc6ae0541d6d4a00b2557c1d5a978e212fec1d", "ae0819a6083ed9d264d719ea0414b3ca43db4aa093d78818929a147ed2475de4"],
].map(([id, name, fileName, outputs, liveSha256, candidateSha256]) => Object.freeze({
  id, name, fileName, outputs, liveSha256, candidateSha256,
})));

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

export function buildFocusedSubscriptionBindingCandidate(source, targets = SUBSCRIPTION_BINDING_TARGETS) {
  return buildFocusedSubscriptionReturnCandidate(source, targets);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values[key]) fail("Invalid arguments");
    values[key] = value;
  }
  const allowed = new Set(["--workspace", "--output", "--import", "--report"]);
  if (Object.keys(values).some((key) => !allowed.has(key))
    || [...allowed].some((key) => !values[key])) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --import <nodes.json> --report <report.json>");
  }
  return values;
}

function prepareTargets(workspace, paths) {
  const resolved = paths.map((value) => path.resolve(value));
  if (new Set(resolved).size !== resolved.length) fail("Output paths must be distinct");
  for (const target of resolved) {
    const relative = path.relative(workspace, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("Outputs must stay inside the live workspace");
    if (fs.existsSync(target) || fs.lstatSync(path.dirname(target), { throwIfNoEntry: false })?.isSymbolicLink()) {
      fail(`Refusing unsafe or existing output: ${target}`);
    }
  }
  const outputDirectory = path.dirname(resolved[0]);
  if (!resolved.every((target) => path.dirname(target) === outputDirectory)) fail("Outputs must share one directory");
  if (path.dirname(outputDirectory) !== workspace || path.basename(outputDirectory) !== "candidate-subscription-binding") {
    fail("Outputs must use the workspace candidate-subscription-binding directory");
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDirectory, 0o700);
  if (fs.realpathSync(outputDirectory) !== outputDirectory) fail("Candidate output directory must be canonical");
  return resolved;
}

function main(argv) {
  const args = parseArgs(argv);
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  if (
    verified.sourceSha256 !== SUBSCRIPTION_BINDING_LIVE_CONTRACT.sourceSha256
    || verified.nodeCount !== SUBSCRIPTION_BINDING_LIVE_CONTRACT.nodeCount
  ) {
    fail("Fresh live source baseline changed");
  }
  if (
    verified.source.filter((node) => node.type === "http in").length
    !== SUBSCRIPTION_BINDING_LIVE_CONTRACT.httpInputCount
  ) {
    fail("Fresh live HTTP input count changed");
  }
  const tab = verified.source.filter((node) => node.id === TAB_ID && node.type === "tab");
  if (tab.length !== 1 || tab[0].label !== "LK Games" || tab[0].disabled === true) fail("LK Games tab contract mismatch");

  const built = buildFocusedSubscriptionBindingCandidate(verified.source);
  const [outputPath, importPath, reportPath] = prepareTargets(verified.workspace, [
    args["--output"], args["--import"], args["--report"],
  ]);
  const outputText = `${JSON.stringify(built.flow, null, 2)}\n`;
  const importText = `${JSON.stringify(built.importNodes, null, 2)}\n`;
  const report = {
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(outputText),
    importSha256: sha256(importText),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    httpInputCount: SUBSCRIPTION_BINDING_LIVE_CONTRACT.httpInputCount,
    changedNodeCount: built.changes.length,
    changes: built.changes,
    topologyChanged: false,
    routesChanged: false,
    deploymentPerformed: false,
  };
  fs.writeFileSync(outputPath, outputText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(importPath, importText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node

// Focused Node-RED generation: the LK1 paid-join transaction readback must read
// the checkout link and the client/booking evidence from the real Viva DTO.
//
// The installed 2026-09-15 flow on 147 is a chained composition, so the
// generation-agnostic HUB builder cannot reproduce it (its HUB preimages are a
// superseded generation). This patcher therefore replaces exactly one step of
// one function body with the reviewed source fragment and pins both the live
// preimage and the resulting body.
//
// This is preparation only. It never deploys, imports, restarts or activates
// anything, and it fails closed unless the supplied preimage is exactly the
// reviewed live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const READBACK_DEPLOYMENT_ID = "lk1-payment-readback";
export const READBACK_TARGET = Object.freeze({
  id: "lk_subscription_booking_router_20260804",
  step: "lk1_transaction_readback",
  // sha256 of the exact live gateway function body pulled from 147 at
  // 2026-09-15T13:13:10Z (source flow sha256
  // 4afaa7708a4084666626a25ab8437e1ef1b7680a17b010ac044781cbb5d77df3).
  liveGatewaySha256: "7ac1f5f116a46faca5ed9f0664706129166b22b431080c9518aa5949f05ca099",
  liveStepSha256: "b925137d80e1427108e2d2da03c84990785ee7a070ab692b987af1d3007a42a4",
  // Re-pinned 2026-09-26 (owner decision «Дружба Топократы»): the reviewed readback step now
  // resolves the event-payment binding through `lk1EventPaymentQuoteBinding`, which prices the
  // club training co-pay and the club full-price shape before the reviewed binding.
  reviewedStepSha256: "4cd5744b639aab54f7cd181dbcde5519fae4ac39635d2710b768a6642f84d565",
  patchedGatewaySha256: "abf46e8b1a05ca4d013ed0c3d9e168a2ae00a1d8eb5e866c3290acc5f47672d9",
  reviewedSource: "scripts/nodered_lk1_hub_nodes/gateway.js",
});

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function extractStep(text, step) {
  const marker = `if (ctx.step === "${step}") {`;
  if (typeof text !== "string" || text.split(marker).length !== 2) {
    throw new Error(`Step anchor drift: ${step}`);
  }
  const start = text.indexOf(marker);
  const end = text.indexOf("\nif (ctx.step === ", start + marker.length);
  if (end < 0) throw new Error(`Step end drift: ${step}`);
  return { start, end, block: text.slice(start, end) };
}

export function reviewedReadbackStep(repoRoot = path.join(SCRIPT_DIR, "..")) {
  const source = fs.readFileSync(path.join(repoRoot, READBACK_TARGET.reviewedSource), "utf8");
  const { block } = extractStep(source, READBACK_TARGET.step);
  if (sha256(block) !== READBACK_TARGET.reviewedStepSha256) {
    throw new Error("Reviewed readback source drift");
  }
  return block;
}

export function patchLk1PaymentReadbackBody(source, target = READBACK_TARGET, reviewedStep = reviewedReadbackStep()) {
  if (sha256(source) !== target.liveGatewaySha256) {
    throw new Error("LK1 readback gateway preimage drift");
  }
  const { start, end, block } = extractStep(source, target.step);
  if (sha256(block) !== target.liveStepSha256) {
    throw new Error("LK1 readback step preimage drift");
  }
  if (block === reviewedStep) throw new Error("LK1 readback step is already patched");
  const patched = source.slice(0, start) + reviewedStep + source.slice(end);
  if (sha256(patched) !== target.patchedGatewaySha256) {
    throw new Error("LK1 readback postimage drift");
  }
  // A Node-RED function body must stay parseable as a function body.
  new Function("msg", "node", "global", "flow", "env", patched);
  return patched;
}

export function composeLk1PaymentReadbackArtifacts(liveBytes, target = READBACK_TARGET, reviewedStep = reviewedReadbackStep()) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  const node = flow.find((candidate) => candidate.id === target.id);
  if (!node || node.type !== "function" || node.d === true || node.disabled === true
    || !Number.isInteger(node.outputs) || node.outputs < 1 || node.wires?.length !== node.outputs
    || typeof node.func !== "string") {
    throw new Error(`Node contract mismatch: ${target.id}`);
  }
  node.func = patchLk1PaymentReadbackBody(node.func, target, reviewedStep);
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  return {
    flow,
    candidateBytes,
    changes: [{ id: target.id, fields: ["func"] }],
  };
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function prepareTargets(workspace, requested) {
  const canonical = (value) => {
    if (!path.isAbsolute(value)) throw new Error("Output paths must be absolute");
    if (path.resolve(value) !== value) throw new Error("Output paths must be canonical");
    if (fs.existsSync(value)) throw new Error(`Refusing to overwrite output: ${value}`);
    if (value === workspace || value.startsWith(`${workspace}${path.sep}`)) {
      throw new Error("Outputs must stay outside the live workspace");
    }
    return value;
  };
  return requested.map(canonical);
}

function main(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
      return;
    }
    if (values[key] !== undefined) {
      fail(`Duplicate argument: ${key}`);
      return;
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
    return;
  }

  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeLk1PaymentReadbackArtifacts(liveBytes);
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const outputText = built.candidateBytes.toString("utf8");
  const report = {
    kind: "FOCUSED_LK1_PAYMENT_READBACK_GENERATION_V1",
    deploymentId: READBACK_DEPLOYMENT_ID,
    target: { id: READBACK_TARGET.id, step: READBACK_TARGET.step,
      beforeSha256: READBACK_TARGET.liveGatewaySha256, afterSha256: READBACK_TARGET.patchedGatewaySha256 },
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(outputText),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length,
    changes: built.changes,
    topologyChanged: false,
    routesChanged: false,
    policyChanged: false,
    deploymentPerformed: false,
    liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, outputText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
}

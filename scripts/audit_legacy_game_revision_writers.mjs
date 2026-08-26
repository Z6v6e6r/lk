#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const DEFAULT_REGISTRY = path.join(SCRIPT_DIR, "legacy_game_revision_writers.json");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function incomingIndex(flow) {
  const incoming = new Map();
  for (const node of flow) {
    for (const target of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      const values = incoming.get(target) || [];
      values.push(node.id);
      incoming.set(target, values);
    }
  }
  return incoming;
}

function ancestors(flow, nodeId, maxDepth = 4) {
  const byId = new Map(flow.map((node) => [node.id, node]));
  const incoming = incomingIndex(flow);
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  const result = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next = [];
    for (const id of frontier) {
      for (const parentId of incoming.get(id) || []) {
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        next.push(parentId);
        const node = byId.get(parentId);
        if (node) result.push(node);
      }
    }
    frontier = next;
  }
  return result;
}

function descendants(flow, nodeId, maxDepth = 6) {
  const byId = new Map(flow.map((node) => [node.id, node]));
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  const result = [];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const next = [];
    for (const id of frontier) {
      const node = byId.get(id);
      for (const childId of (Array.isArray(node?.wires) ? node.wires : []).flat()) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        next.push(childId);
        const child = byId.get(childId);
        if (child) result.push(child);
      }
    }
    frontier = next;
  }
  return result;
}

export function auditLegacyGameRevisionWriters(flow, registry, { stage = "active", repoRoot = REPO_ROOT } = {}) {
  if (!Array.isArray(flow)) throw new Error("Writer audit requires a Node-RED flow array");
  if (!registry || !Array.isArray(registry.writers)) throw new Error("Writer registry is invalid");
  if (stage !== "active" && stage !== "candidate") throw new Error(`Unknown writer audit stage ${stage}`);

  const registered = new Map(registry.writers.map((writer) => [writer.nodeId, writer]));
  const readOnlyOperations = new Set(["find", "findOne", "count", "countDocuments", "distinct"]);
  const actual = flow.filter((node) => (
    node?.type === "mongodb4"
    && (
      node.operation === "aggregate"
      || (
        !readOnlyOperations.has(node.operation)
        && (node.collection === "lk_games" || !String(node.collection || "").trim())
      )
    )
  ));
  const unknown = actual.filter((node) => !registered.has(node.id));
  const missing = registry.writers.filter((writer) => !actual.some((node) => node.id === writer.nodeId));
  if (unknown.length || missing.length) {
    throw new Error(`Legacy game writer inventory drift: unknown=${unknown.map((node) => node.id).join(",") || "none"}; missing=${missing.map((writer) => writer.nodeId).join(",") || "none"}`);
  }

  const sourceChecks = [];
  for (const writer of registry.writers) {
    const upstream = ancestors(flow, writer.nodeId);
    const downstream = descendants(flow, writer.nodeId);
    for (const source of writer.sourceNodes || []) {
      if (stage === "active" && !source.activeSha256) continue;
      const expectedHash = stage === "candidate" ? source.candidateSha256 : source.activeSha256;
      const flowNode = stage === "candidate"
        ? flow.find((node) => node.id === source.nodeId)
        : upstream.find((node) => node.id === source.nodeId);
      const generated = stage === "candidate" ? source.candidateGenerated === true : source.activeGenerated === true;
      const checkedPath = stage === "candidate" && source.candidateSourcePath
        ? source.candidateSourcePath
        : source.sourcePath;
      const sourceHash = generated
        ? sha256(flowNode?.func || "")
        : sha256(fs.readFileSync(path.resolve(repoRoot, checkedPath), "utf8"));
      if (sourceHash !== expectedHash) {
        throw new Error(`Tracked writer source drift for ${checkedPath}`);
      }
      if (stage === "candidate") {
        if (!flowNode || sha256(flowNode.func || "") !== expectedHash) {
          throw new Error(`Candidate writer ${writer.nodeId} does not use ${source.nodeId}`);
        }
        const graph = source.candidateRelation === "ancestor"
          ? upstream
          : source.candidateRelation === "descendant"
            ? downstream
            : null;
        if (!graph) {
          throw new Error(`Candidate writer ${writer.nodeId} source ${source.nodeId} has no graph relation`);
        }
        if (!graph.some((node) => node.id === source.nodeId)) {
          throw new Error(`Candidate writer ${writer.nodeId} is disconnected from ${source.candidateRelation} ${source.nodeId}`);
        }
      } else if (source.activeSha256) {
        if (!flowNode || sha256(flowNode.func || "") !== source.activeSha256) {
          throw new Error(`Active writer preimage drift for ${source.nodeId}`);
        }
      }
      sourceChecks.push({ writerId: writer.nodeId, sourceNodeId: source.nodeId, sourceHash, expectedHash, generated });
    }
  }

  if (stage === "candidate") {
    const requiredTokens = [
      ["e656cff36a8cd210", "tenantKey,", "revision: expectedRevision === null ? { $exists: false } : expectedRevision", "$inc: { revision: 1 }"],
      ["lk_game_create_revision_ack_20260826", "LEGACY_GAME_VERSION_CONFLICT", "_recordForResponse"],
      ["lk_game_patch_cas_guard_20260801", "expectedRevision", "expectedRevision < 1"],
      ["lk_game_patch_apply_cas_20260801", "tenantKey: ctx.tenantKey", "revision: ctx.expectedRevision", "revision: 1"],
      ["bcc3dccf8d64f9bb", "tenantKey: ctx.sourceTenantKey", "revision: ctx.sourceRevision", "$inc", "_splitCleanupRevisionDeferred"],
      ["lk_split_cleanup_revision_ack_20260826", "_legacyCleanupRecovery", "intentId"],
      ["lk_split_leave_game_update_build_20260801", "tenantKey: ctx.tenantKey", "revision: game.revision", "$inc"],
      ["legacy_roster_bridge_build_20260816", "tenantKey: ctx.tenantKey", "query.revision = game.revision", "$inc: { revision: 1 }"],
      ["eb7060667c2da065", "tenantKey", "revision: sourceRevision", "$inc"],
      ["result_submit_after_write_003", "tenantKey", "revision: sourceRevision", "$inc: { revision: 1 }"],
      ["lk_result_submit_game_revision_ack_20260826", "LEGACY_GAME_VERSION_CONFLICT", "_resultSubmitRevisionDeferred"],
      ["cb002a5dcea9ce51", "_resultConfirmRevisionDeferred", "return [null, gameMsg"],
      ["lk_result_confirm_game_revision_ack_20260826", "LEGACY_GAME_VERSION_CONFLICT", "_resultConfirmRevisionDeferred"],
      ["c67e08684d1e4fe9", "legacyGameProjectionOutbox", "AT_MOST_ONCE", "_resultConfirmReplayOutbox"],
      ["lk_result_confirm_replay_outbox_20260826", "payloadJson", "RESULT_SIDE_EFFECT_RECOVERY_REQUIRED"],
    ];
    for (const [nodeId, ...tokens] of requiredTokens) {
      const text = flow.find((node) => node.id === nodeId)?.func || "";
      if (tokens.some((token) => !text.includes(token))) {
        throw new Error(`Mandatory revision token missing from ${nodeId}`);
      }
    }
  }

  return {
    ok: true,
    stage,
    writerCount: actual.length,
    rosterOrLifecycleWriterCount: registry.writers.filter((item) => item.affectsRosterOrLifecycle).length,
    exemptWriterCount: registry.writers.filter((item) => !item.affectsRosterOrLifecycle).length,
    sourceChecks,
  };
}

function parseArgs(argv) {
  const result = { stage: "active", registry: DEFAULT_REGISTRY };
  for (let index = 0; index < argv.length; index += 2) result[argv[index].slice(2)] = argv[index + 1];
  if (!result.flow) throw new Error("Usage: --flow <selected-tab.nodes.json> [--stage active|candidate] [--registry path]");
  return result;
}

function main(argv) {
  const args = parseArgs(argv);
  const flow = JSON.parse(fs.readFileSync(path.resolve(args.flow), "utf8"));
  const registry = JSON.parse(fs.readFileSync(path.resolve(args.registry), "utf8"));
  if (args.validation) {
    const validation = JSON.parse(fs.readFileSync(path.resolve(args.validation), "utf8"));
    if (validation.sourceSha256 !== registry.provenance.activeFlowSha256
      || validation.candidateSha256 !== registry.provenance.selectedTabCandidateSha256) {
      throw new Error("Writer audit provenance does not match the fresh live-flow validation report");
    }
  }
  console.log(JSON.stringify(auditLegacyGameRevisionWriters(flow, registry, { stage: args.stage }), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

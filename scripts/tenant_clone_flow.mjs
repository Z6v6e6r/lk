#!/usr/bin/env node
/**
 * Deterministic clone of a tenant-owned slice of the live Node-RED flow.
 *
 * Source of truth is the live flow pulled from `lk-primary-147`
 * (`npm run nodered:modular:pull-147`). This tool never writes a flow file on the
 * host: it emits a reviewable candidate fragment plus a report, so the tenant
 * slice can be inspected and applied through the guarded installer.
 *
 * Usage:
 *   node scripts/tenant_clone_flow.mjs \
 *     --source <source.flow.json> \
 *     --profile tenants/<slug>.json \
 *     --out <candidate.flow.json> \
 *     --report <report.json>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { parseTenantProfile } from "./lib/tenantCloneProfile.mjs";

const SECRET_FIELDS = ["uri", "password", "token", "secret", "credentials", "apiKey", "authToken"];
const BODY_FIELDS = ["func", "initialize", "finalize"];
const TAB_TYPE = "tab";

const usage = () => {
  console.error(
    "Usage: node scripts/tenant_clone_flow.mjs --source <flow.json> --profile <profile.json> --out <candidate.json> --report <report.json>",
  );
};

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    args[key] = value;
    i += 1;
  }
  return args;
};

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replaceTenantToken = (text, from, to) => (text.includes(from) ? text.split(from).join(to) : text);

const applyBodyRules = (text, profile) => {
  let out = replaceTenantToken(text, profile.sourceVivaTenant, profile.vivaTenant);
  out = out.split(profile.sourceOffset).join(profile.offset);
  out = out.split(profile.sourceIana).join(profile.iana);
  for (const [from, to] of Object.entries(profile.globalKeyMap)) {
    out = out.split(from).join(to);
  }
  for (const [from, to] of Object.entries(profile.vivaIds)) {
    if (typeof to !== "number" && typeof to !== "string") continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(String(from))}\\b`, "g"), String(to));
  }
  return out;
};

const collectText = (value, sink) => {
  if (typeof value === "string") {
    sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, sink);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) collectText(item, sink);
  }
};

export const analyzeFlow = ({ flow, profile }) => {
  if (!Array.isArray(flow)) throw new Error("source flow must be a JSON array");
  const byId = new Map();
  for (const node of flow) {
    if (!isPlainObject(node) || typeof node.id !== "string" || !node.id) {
      throw new Error("source flow contains an invalid node");
    }
    if (byId.has(node.id)) throw new Error(`source flow has a duplicate node id: ${node.id}`);
    byId.set(node.id, node);
  }

  const tabs = flow.filter((node) => node.type === TAB_TYPE);
  const tabByLabel = new Map(tabs.map((tab) => [tab.label, tab]));
  const missingTabs = profile.tabs.filter((label) => !tabByLabel.has(label));
  if (missingTabs.length) {
    throw new Error(`source flow is missing tab(s): ${missingTabs.join(", ")}`);
  }

  const includedTabIds = new Set(profile.tabs.map((label) => tabByLabel.get(label).id));
  const tabIdToLabel = new Map(tabs.map((tab) => [tab.id, tab.label]));
  const reuse = new Set(profile.reuseConfigNodeIds || []);

  const referencedIds = (node) => {
    const refs = new Set();
    if (typeof node.z === "string") refs.add(node.z);
    if (typeof node.clientNode === "string") refs.add(node.clientNode);
    if (typeof node.g === "string") refs.add(node.g);
    if (Array.isArray(node.scope)) for (const id of node.scope) refs.add(id);
    if (Array.isArray(node.links)) for (const id of node.links) refs.add(id);
    if (Array.isArray(node.wires)) {
      for (const wire of node.wires) {
        if (Array.isArray(wire)) for (const id of wire) refs.add(id);
      }
    }
    if (typeof node.type === "string" && /^[0-9a-f]{16}$/.test(node.type)) refs.add(node.type);
    return refs;
  };

  // 1. Universe: every node that lives in an included tab.
  const universe = new Set(includedTabIds);
  for (const node of flow) {
    if (includedTabIds.has(node.z)) universe.add(node.id);
  }

  // 2. Roots: kept http-in endpoints only. Inject-driven maintenance branches (split
  // cleanup, subscription schedulers) are intentionally not roots — a tenant clone
  // starts from the HTTP surface, everything else follows the wires.
  const dropPatterns = profile.dropHttpIn.map((pattern) => new RegExp(pattern));
  const droppedHttpIn = [...universe]
    .map((id) => byId.get(id))
    .filter((node) => node && node.type === "http in" && typeof node.url === "string")
    .filter((node) => dropPatterns.some((pattern) => pattern.test(node.url)));

  const keep = new Set();
  for (const node of flow) {
    if (universe.has(node.id) && node.type === "http in" && !droppedHttpIn.some((dropped) => dropped.id === node.id)) {
      keep.add(node.id);
    }
  }
  for (const tabId of includedTabIds) keep.add(tabId);

  // 3. Forward closure. Catch/status nodes join when their scope intersects the keep set.
  const crossTabDependencies = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of flow) {
      if (!universe.has(node.id)) continue;
      const watched = node.type === "catch" || node.type === "status";
      if (watched) {
        const scoped = Array.isArray(node.scope) ? node.scope : [];
        const intersects = scoped.length === 0 || scoped.some((id) => keep.has(id));
        if (!intersects) continue;
        if (!keep.has(node.id)) {
          keep.add(node.id);
          changed = true;
        }
      }
      if (!keep.has(node.id)) continue;
      for (const ref of referencedIds(node)) {
        if (!byId.has(ref) || keep.has(ref)) continue;
        const target = byId.get(ref);
        const outsideUniverse = !universe.has(ref) && !reuse.has(ref);
        if (outsideUniverse) {
          const label = typeof target.z === "string" ? tabIdToLabel.get(target.z) || target.z : "(config)";
          crossTabDependencies.add(
            `${label} -> ${node.id} (${node.type}${node.name ? `: ${node.name}` : ""}) [target ${target.id}/${target.type}/z=${String(target.z)}]`,
          );
        }
        keep.add(ref);
        changed = true;
      }
    }
    for (const node of flow) {
      if (universe.has(node.id) || !keep.has(node.id)) continue;
      for (const ref of referencedIds(node)) {
        if (byId.has(ref) && universe.has(ref) && !keep.has(ref)) {
          keep.add(ref);
          changed = true;
        }
      }
    }
  }

  // Catch/status nodes lost their whole scope once pruned branches are gone.
  const emptiedScopes = new Set();
  for (const id of keep) {
    const node = byId.get(id);
    if (!node || (node.type !== "catch" && node.type !== "status")) continue;
    const scoped = Array.isArray(node.scope) ? node.scope.filter((scopeId) => keep.has(scopeId)) : [];
    if (scoped.length === 0) emptiedScopes.add(id);
  }
  for (const id of emptiedScopes) keep.delete(id);

  const pruned = new Set([...universe].filter((id) => !keep.has(id)));

  // 4. Deterministic identity remap.
  const emitted = [...keep].filter((id) => !reuse.has(id));
  const idMap = new Map(emitted.map((id) => [id, id.startsWith("tab:") ? id : null]));
  for (const id of emitted) {
    const node = byId.get(id);
    if (node && node.type === TAB_TYPE) idMap.set(id, crypto.createHash("sha1").update(`${profile.slug}:tab:${id}`).digest("hex").slice(0, 16));
    else idMap.set(id, crypto.createHash("sha1").update(`${profile.slug}:${id}`).digest("hex").slice(0, 16));
  }
  const remapId = (id) => (reuse.has(id) ? id : idMap.get(id) || id);

  const rewriteUrlPrefix = (url) => (url.startsWith(profile.pathPrefix) ? url : `${profile.pathPrefix}${url.startsWith("/") ? "" : "/"}${url}`);
  const rewriteCollection = (collection) =>
    collection.startsWith(profile.collectionPrefix) ? collection : `${profile.collectionPrefix}${collection}`;

  const appliedBodyReplacements = new Set();

  const cloned = emitted.map((id) => {
    const source = byId.get(id);
    const node = JSON.parse(JSON.stringify(source));
    node.id = remapId(source.id);
    if (typeof source.z === "string" && !reuse.has(source.z)) node.z = remapId(source.z);
    if (typeof source.clientNode === "string") node.clientNode = remapId(source.clientNode);
    if (typeof source.g === "string") node.g = remapId(source.g);
    if (Array.isArray(source.scope)) node.scope = source.scope.filter((scopeId) => keep.has(scopeId)).map(remapId);
    if (Array.isArray(source.links)) node.links = source.links.map(remapId);
    if (Array.isArray(source.wires)) {
      node.wires = source.wires.map((wire) => (Array.isArray(wire) ? wire.map(remapId) : wire));
    }
    if (typeof source.type === "string" && /^[0-9a-f]{16}$/.test(source.type)) node.type = remapId(source.type);

    if (node.type === "http in" && typeof node.url === "string") node.url = rewriteUrlPrefix(node.url);
    if (node.type === "mongodb4" && typeof node.collection === "string") node.collection = rewriteCollection(node.collection);
    for (const field of BODY_FIELDS) {
      if (typeof node[field] !== "string") continue;
      let body = node[field];
      for (const [index, rule] of profile.bodyReplacements.entries()) {
        if (!body.includes(rule.find)) continue;
        body = body.split(rule.find).join(rule.replace);
        appliedBodyReplacements.add(index);
      }
      node[field] = applyBodyRules(body, profile);
    }
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && value.includes(profile.sourceVivaTenant)) {
        node[key] = replaceTenantToken(value, profile.sourceVivaTenant, profile.vivaTenant);
      }
    }
    return node;
  });

  // 5. Validation.
  const errors = [];
  const warnings = [];
  const danglingInSource = [];
  const ids = new Set();
  for (const node of cloned) {
    if (ids.has(node.id)) errors.push(`duplicate remapped id: ${node.id}`);
    ids.add(node.id);
  }
  for (const node of cloned) {
    for (const field of SECRET_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(node, field) && typeof node[field] === "string" && node[field].trim()) {
        errors.push(`cloned node ${node.id} (${node.type}) carries secret-bearing field "${field}"; reuse the live config node instead`);
      }
    }
    const checkTargets = [];
    if (Array.isArray(node.wires)) for (const wire of node.wires) if (Array.isArray(wire)) checkTargets.push(...wire);
    if (Array.isArray(node.links)) checkTargets.push(...node.links);
    for (const target of checkTargets) {
      if (ids.has(target) || reuse.has(target)) continue;
      const sourceTargetId = [...idMap.entries()].find(([, clonedId]) => clonedId === target)?.[0];
      if (sourceTargetId && byId.has(sourceTargetId)) {
        errors.push(`node ${node.id} (${node.type}) wires to node ${sourceTargetId} that the clone dropped`);
      } else {
        danglingInSource.push(`${node.id} (${node.type}) -> ${target}`);
      }
    }
  }
  if (danglingInSource.length) {
    warnings.push(`${danglingInSource.length} wire target(s) do not exist in the live flow either: ${danglingInSource.slice(0, 5).join("; ")}`);
  }
  for (const node of cloned) {
    if (node.type === "http in" && typeof node.url === "string" && !node.url.startsWith(profile.pathPrefix)) {
      errors.push(`http in ${node.id} url "${node.url}" does not start with ${profile.pathPrefix}`);
    }
    if (node.type === "mongodb4" && typeof node.collection === "string" && !node.collection.startsWith(profile.collectionPrefix)) {
      errors.push(`mongodb4 ${node.id} collection "${node.collection}" does not start with ${profile.collectionPrefix}`);
    }
  }

  const textSink = [];
  collectText(cloned, textSink);
  const leaked = textSink.filter((text) => text.includes(profile.sourceVivaTenant)).length;
  if (leaked) errors.push(`candidate still contains the source tenant token "${profile.sourceVivaTenant}" in ${leaked} string(s)`);

  // Function bodies must still parse after rewriting; a broken body only shows up at runtime.
  const bodyErrors = [];
  for (const node of cloned) {
    for (const field of BODY_FIELDS) {
      const body = node[field];
      if (typeof body !== "string" || !body.trim()) continue;
      try {
        // Parse-only check: no parameters, so bodies that declare `context`/`msg`
        // themselves do not collide with the harness scope.
        new vm.Script(`(async function () {\n${body}\n})`);
      } catch (error) {
        bodyErrors.push(`${node.id} (${node.type}) ${field}: ${error.message}`);
      }
    }
  }
  for (const bodyError of bodyErrors) errors.push(`function body does not parse: ${bodyError}`);

  const unresolvedVivaIds = Object.entries(profile.vivaIds)
    .filter(([, value]) => value === null || value === undefined || value === "" || /^TODO/i.test(String(value)))
    .map(([key]) => key);
  if (unresolvedVivaIds.length) {
    warnings.push(`unresolved Viva dictionary id(s): ${unresolvedVivaIds.join(", ")} — the clone must not be applied before they are mapped for this tenant`);
  }
  for (const [index, rule] of profile.bodyReplacements.entries()) {
    if (!rule.required || appliedBodyReplacements.has(index)) continue;
    errors.push(`required body replacement was not found in the source flow: ${JSON.stringify(rule.find.slice(0, 120))}`);
  }
  if (crossTabDependencies.size) {
    warnings.push(`${crossTabDependencies.size} cross-tab reference(s) point outside the cloned tabs`);
  }

  const httpInPaths = cloned.filter((node) => node.type === "http in").map((node) => `${node.method || "get"} ${node.url}`).sort();
  const collections = [...new Set(cloned.filter((node) => node.type === "mongodb4").map((node) => node.collection))].sort();

  const report = {
    formatVersion: 1,
    slug: profile.slug,
    generatedAt: new Date().toISOString(),
    sourceVivaTenant: profile.sourceVivaTenant,
    vivaTenant: profile.vivaTenant,
    tabs: profile.tabs,
    clonedTabIds: [...includedTabIds].map((id) => ({ source: id, cloned: remapId(id), label: tabIdToLabel.get(id) })),
    counts: {
      sourceNodes: flow.length,
      clonedNodes: cloned.length,
      prunedNodes: pruned.size,
      droppedHttpIn: droppedHttpIn.length,
      reusedConfigNodes: [...reuse].length,
    },
    droppedHttpInPaths: droppedHttpIn.map((node) => `${node.method || "get"} ${node.url}`).sort(),
    httpInPaths,
    collections,
    crossTabDependencies: [...crossTabDependencies].sort(),
    unresolvedVivaIds,
    appliedBodyReplacements: appliedBodyReplacements.size,
    bodyReplacements: profile.bodyReplacements.length,
    blockers: [...profile.blockers],
    errors,
    warnings,
    deployable: errors.length === 0 && warnings.length === 0 && profile.blockers.length === 0,
  };

  return { candidate: cloned, report };
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.source || !args.profile || !args.out || !args.report) {
    usage();
    process.exitCode = 2;
    return;
  }

  const profileRaw = JSON.parse(fs.readFileSync(path.resolve(args.profile), "utf8"));
  const profile = parseTenantProfile(profileRaw);
  const flow = JSON.parse(fs.readFileSync(path.resolve(args.source), "utf8"));
  const { candidate, report } = analyzeFlow({ flow, profile });

  fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  console.log(`slug=${report.slug}`);
  console.log(`clonedNodes=${report.counts.clonedNodes} prunedNodes=${report.counts.prunedNodes} droppedHttpIn=${report.counts.droppedHttpIn}`);
  console.log(`httpInPaths=${report.httpInPaths.length} collections=${report.collections.length}`);
  console.log(`errors=${report.errors.length} warnings=${report.warnings.length} deployable=${report.deployable}`);
  for (const error of report.errors) console.error(`ERROR ${error}`);
  for (const warning of report.warnings) console.error(`WARN ${warning}`);
  if (report.errors.length) process.exitCode = 1;
};

if (process.argv[1] && process.argv[1].endsWith("tenant_clone_flow.mjs")) {
  main();
}

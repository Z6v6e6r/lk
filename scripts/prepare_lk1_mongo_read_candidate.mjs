#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const READ_CANDIDATE_TARGETS = Object.freeze([
  {
    id: '1dbd5de98e73a04c', tabId: '4b91e2a2413688db', tabLabel: 'LK Games',
    name: 'Build chat messages query', file: 'nodered_chat_nodes/fn_chat_get_build_query_secure.js',
    preimageSha256: '198323d304316910e3bb10c18656aa8f15595f47f94368ffc5b7760c972d3a1c',
    outputs: 3, wires: [['4d967af31e8055fb'], ['303126e394d52ade'], ['645c9add7065c07b']],
    mongoId: '4d967af31e8055fb', collection: 'chat_messages',
  },
  {
    id: '5a9da5699137937c', tabId: '81e35b13685eec48', tabLabel: 'LK Support',
    name: 'Support dialog messages prepare', file: 'nodered_support_nodes/fn_support_dialog_messages_prepare.js',
    preimageSha256: '38885259eb556af1be6ac66364095138ea916b8fdf5a086c9449e507ffae6662',
    outputs: 3, wires: [['cd44f9166232449b'], ['9d2ab6d44c9ab611'], ['ca7984daa2fe8824']],
    mongoId: 'cd44f9166232449b', collection: 'support_messages',
  },
  {
    id: 'f435ae81f62cdc4f', tabId: '81e35b13685eec48', tabLabel: 'LK Support',
    name: 'Support analytics daily prepare', file: 'nodered_support_nodes/fn_support_analytics_daily_prepare.js',
    preimageSha256: '746beddd286fc2b32c627e4d0f5d79b4fa52547718fc3f48872d8cd39347aa1f',
    outputs: 3, wires: [['f2d916bb5f84f76e'], ['118dd0668f1b574f'], ['00cd684dbefb6c20']],
    mongoId: 'f2d916bb5f84f76e', collection: 'support_messages',
  },
]);

function exactNode(flow, id) {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) throw new Error('TARGET_NODE_COUNT_MISMATCH');
  return matches[0];
}

export function buildReadCandidate(flow, sources, targets = READ_CANDIDATE_TARGETS) {
  if (!Array.isArray(flow)) throw new Error('FLOW_INVALID');
  const candidate = structuredClone(flow);
  const changes = [];
  for (const target of targets) {
    const tab = exactNode(candidate, target.tabId);
    if (tab.type !== 'tab' || tab.label !== target.tabLabel || tab.disabled === true) {
      throw new Error('TARGET_TAB_MISMATCH');
    }
    const node = exactNode(candidate, target.id);
    if (node.type !== 'function' || node.z !== target.tabId || node.name !== target.name
      || node.outputs !== target.outputs || JSON.stringify(node.wires) !== JSON.stringify(target.wires)
      || sha256(node.func || '') !== target.preimageSha256) {
      throw new Error('TARGET_FUNCTION_PREIMAGE_MISMATCH');
    }
    const mongo = exactNode(candidate, target.mongoId);
    if (mongo.type !== 'mongodb4' || mongo.z !== target.tabId || mongo.operation !== 'find'
      || mongo.collection !== target.collection || mongo.clientNode !== '4e820638cc39c730') {
      throw new Error('TARGET_MONGO_BINDING_MISMATCH');
    }
    const source = sources[target.file];
    if (typeof source !== 'string' || !source.trim()) throw new Error('CANDIDATE_SOURCE_MISSING');
    node.func = source.trimEnd();
    changes.push({ id: node.id, name: node.name, beforeSha256: target.preimageSha256, afterSha256: sha256(node.func) });
  }
  for (let index = 0; index < flow.length; index += 1) {
    const before = structuredClone(flow[index]);
    const after = structuredClone(candidate[index]);
    if (targets.some((target) => target.id === before.id)) {
      delete before.func;
      delete after.func;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('UNEXPECTED_FLOW_CHANGE');
  }
  return { candidate, changes };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

function externalOutputDirectory(rawPath) {
  if (!rawPath || !path.isAbsolute(rawPath)) throw new Error('OUTPUT_PATH_INVALID');
  const parent = fs.realpathSync(path.dirname(rawPath));
  const absolute = path.join(parent, path.basename(rawPath));
  if (absolute !== rawPath || !absolute.startsWith('/private/tmp/')
    || absolute.startsWith(`${REPO_ROOT}${path.sep}`) || fs.existsSync(absolute)) {
    throw new Error('OUTPUT_PATH_INVALID');
  }
  return absolute;
}

function main() {
  const workspace = option('--workspace');
  const outputDir = externalOutputDirectory(option('--output-dir'));
  const verified = verifyWorkspace(workspace, { quiet: true });
  const sources = Object.fromEntries(READ_CANDIDATE_TARGETS.map((target) => [
    target.file, fs.readFileSync(path.join(SCRIPT_DIR, target.file), 'utf8'),
  ]));
  const { candidate, changes } = buildReadCandidate(verified.source, sources);
  fs.mkdirSync(outputDir, { mode: 0o700 });
  const candidatePath = path.join(outputDir, 'candidate.flow.json');
  const reportPath = path.join(outputDir, 'report.json');
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
  fs.writeFileSync(candidatePath, candidateBytes, { mode: 0o600, flag: 'wx' });
  const report = {
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(candidateBytes),
    nodeCount: candidate.length,
    changes,
    candidatePath,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    const safe = new Set(['OUTPUT_PATH_INVALID', 'TARGET_NODE_COUNT_MISMATCH', 'TARGET_TAB_MISMATCH', 'TARGET_FUNCTION_PREIMAGE_MISMATCH', 'TARGET_MONGO_BINDING_MISMATCH', 'CANDIDATE_SOURCE_MISSING', 'UNEXPECTED_FLOW_CHANGE']);
    console.error(safe.has(error.message) ? error.message : 'LK1_READ_CANDIDATE_FAILED');
    process.exitCode = 1;
  }
}

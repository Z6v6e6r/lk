#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_ORIGIN = Object.freeze({
  sourceKind: 'live-147',
  sourceHost: 'lk-primary-147',
  sourceUser: 'root',
  sourcePort: '22',
  remoteFlowPath: '/root/.node-red/flows.json',
});

const DEFAULT_MAX_AGE_SECONDS = 30 * 60;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));

function fail(message) {
  throw new Error(message);
}

function modeBits(stat) {
  return stat.mode & 0o777;
}

function assertMode(stat, expected, description) {
  if (modeBits(stat) !== expected) {
    fail(`${description} must have mode ${expected.toString(8)}`);
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertDirectory(directoryPath, expectedMode, description) {
  const stat = fs.lstatSync(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${description} must be a real directory`);
  }
  const canonical = fs.realpathSync(directoryPath);
  if (canonical !== path.resolve(directoryPath)) {
    fail(`${description} must use its canonical path`);
  }
  assertMode(stat, expectedMode, description);
  return canonical;
}

function assertPrivateRegularFile(filePath, workspace, description) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${description} must be a regular file`);
  }
  if (stat.nlink !== 1) {
    fail(`${description} must not be hard-linked`);
  }
  assertMode(stat, 0o600, description);

  const canonical = fs.realpathSync(filePath);
  if (canonical !== path.resolve(filePath) || !isWithin(workspace, canonical)) {
    fail(`${description} must resolve inside the external workspace`);
  }
  return canonical;
}

export function assertExternalWorkspace(workspaceArg) {
  if (!workspaceArg || !path.isAbsolute(workspaceArg)) {
    fail('Node-RED workspace must be an absolute path');
  }

  const resolved = path.resolve(workspaceArg);
  const workspace = assertDirectory(resolved, 0o700, 'Node-RED workspace');
  if (workspace !== resolved) {
    fail('Node-RED workspace path must be canonical');
  }
  if (isWithin(REPO_ROOT, workspace)) {
    fail('Node-RED workspace must be outside the repository');
  }
  return workspace;
}

function readJson(filePath, description) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail(`${description} must contain valid JSON`);
  }
  return value;
}

export function assertFlowArray(flow, description = 'Node-RED source') {
  if (!Array.isArray(flow)) {
    fail(`${description} must be a JSON array`);
  }

  const ids = new Set();
  for (const node of flow) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      fail(`${description} must contain only node objects`);
    }
    if (typeof node.id !== 'string' || node.id.trim() === '') {
      fail(`${description} contains a node without a non-empty id`);
    }
    if (ids.has(node.id)) {
      fail(`${description} contains duplicate node id: ${node.id}`);
    }
    ids.add(node.id);
  }
  return ids;
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function verifyWorkspace(workspaceArg, options = {}) {
  const workspace = assertExternalWorkspace(workspaceArg);
  const inputDirectory = path.join(workspace, 'input');
  assertDirectory(inputDirectory, 0o700, 'Node-RED input directory');

  const sourcePath = assertPrivateRegularFile(
    path.join(inputDirectory, 'source.flow.json'),
    workspace,
    'Node-RED source flow',
  );
  const metaPath = assertPrivateRegularFile(
    path.join(inputDirectory, 'source.flow.meta.json'),
    workspace,
    'Node-RED source metadata',
  );

  const source = readJson(sourcePath, 'Node-RED source flow');
  assertFlowArray(source);
  const meta = readJson(metaPath, 'Node-RED source metadata');
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    fail('Node-RED source metadata must be a JSON object');
  }

  for (const [key, expected] of Object.entries(EXPECTED_ORIGIN)) {
    if (String(meta[key] ?? '') !== expected) {
      fail(`Node-RED source metadata mismatch for ${key}`);
    }
  }
  if (meta.formatVersion !== 1) {
    fail('Node-RED source metadata has an unsupported formatVersion');
  }
  if (meta.localSourcePath !== sourcePath) {
    fail('Node-RED source metadata localSourcePath is not canonical');
  }
  if (!/^[a-f0-9]{64}$/.test(String(meta.sourceSha256 ?? ''))) {
    fail('Node-RED source metadata has an invalid sourceSha256');
  }
  if (!Number.isInteger(meta.nodeCount) || meta.nodeCount !== source.length) {
    fail('Node-RED source metadata nodeCount does not match the source');
  }

  const sourceSha256 = sha256File(sourcePath);
  if (sourceSha256 !== meta.sourceSha256) {
    fail('Node-RED source hash does not match live-pull metadata');
  }

  const pulledAtMs = Date.parse(meta.pulledAt);
  if (!Number.isFinite(pulledAtMs)) {
    fail('Node-RED source metadata has an invalid pulledAt');
  }
  const nowMs = options.nowMs ?? Date.now();
  const ageSeconds = Math.floor((nowMs - pulledAtMs) / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (ageSeconds < -MAX_FUTURE_SKEW_SECONDS) {
    fail('Node-RED source metadata pulledAt is too far in the future');
  }
  if (ageSeconds > maxAgeSeconds) {
    fail(`Node-RED source is stale (maximum ${maxAgeSeconds} seconds)`);
  }

  const result = {
    workspace,
    inputDirectory,
    sourcePath,
    metaPath,
    source,
    meta,
    sourceSha256,
    nodeCount: source.length,
    freshnessSeconds: Math.max(0, ageSeconds),
  };

  if (!options.quiet) {
    console.log(`sourceSha256=${result.sourceSha256}`);
    console.log(`nodeCount=${result.nodeCount}`);
    console.log(`freshnessSeconds=${result.freshnessSeconds}`);
  }
  return result;
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== '--workspace') {
    fail('Usage: node scripts/verify_nodered_source_origin.mjs --workspace /absolute/external/workspace');
  }
  return argv[1];
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    verifyWorkspace(parseCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

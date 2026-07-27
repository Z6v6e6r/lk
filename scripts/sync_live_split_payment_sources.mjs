#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.join(SCRIPT_DIR, 'nodered_games_nodes');
const LIVE_FLOW_SHA256 = 'd9f84e4fd6b087752dc810b9fc247e3d532cc6580c19a4a822f2111ddebeca4c';

const TARGETS = [
  {
    id: 'f3f9a60354d394da', name: 'Prepare split game payment',
    source: 'fn_split_create_prepare.js', liveSha256: 'd76e532d8f9d3cba655a4fabadf21635c85ed360a4bfac18534e10fef5661bfa',
    acceptedSourceSha256: ['dc02a7052011441d154331e7d4818ca2556e993761b40d34612fa7fc2596489a'],
  },
  {
    id: 'e92e68bf3f08a70c', name: 'Prepare split join payment',
    source: 'fn_split_join_prepare.js', liveSha256: '707fdde66c340769a0c68e6e693bda22eb040b715ef33ad109e39c4709cea950',
    acceptedSourceSha256: ['62cf3dc191f0bdc5b58c950f61df3503af5ec57d8fa7f495d6645f5729e0521e'],
  },
  {
    id: '8f7bd5b482fe9763', name: 'Route Viva split payment',
    source: 'fn_split_router.js', liveSha256: 'd9d6d1f17c12f38b567cf226468caa6780ed3d6e707f55f4af26c066be86b1a4',
    acceptedSourceSha256: ['efe754306d08f4ba53a5ea150beddd5d590a849292774cbf98ab5fe5b5fb441f'],
  },
];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw new Error(message); };

function exactNode(flow, id) {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`Split-payment node ${id} must exist exactly once`);
  return matches[0];
}

function atomicWrite(filePath, value) {
  const temporary = `${filePath}.split-payment-${process.pid}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
}

export function synchronizeLiveSplitPaymentSources(workspace) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (verified.sourceSha256 !== LIVE_FLOW_SHA256) fail('Split-payment flow preimage SHA mismatch');
  const operations = TARGETS.map((target) => {
    const node = exactNode(verified.source, target.id);
    if (node.type !== 'function' || node.name !== target.name || node.z !== '4b91e2a2413688db' || node.outputs !== 3) {
      fail(`Split-payment node ${target.id} contract mismatch`);
    }
    const liveSource = String(node.func ?? '');
    if (sha256(liveSource) !== target.liveSha256) fail(`Split-payment node ${target.id} live body mismatch`);
    const sourcePath = path.join(SOURCE_DIRECTORY, target.source);
    const currentSha256 = sha256(fs.readFileSync(sourcePath));
    if (currentSha256 !== target.liveSha256 && !target.acceptedSourceSha256.includes(currentSha256)) {
      fail(`Tracked split-payment source ${target.source} preimage mismatch`);
    }
    return { target, sourcePath, liveSource, currentSha256 };
  });
  for (const operation of operations) atomicWrite(operation.sourcePath, operation.liveSource);
  return operations.map(({ target, sourcePath, currentSha256 }) => ({
    id: target.id, sourcePath, fromSha256: currentSha256, toSha256: target.liveSha256,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--workspace') fail('Usage: node scripts/sync_live_split_payment_sources.mjs --workspace /absolute/external/workspace');
  process.stdout.write(`${JSON.stringify(synchronizeLiveSplitPaymentSources(process.argv[3]))}\n`);
}

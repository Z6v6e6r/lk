#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const SOURCE_DIR = path.join(REPO_ROOT, 'scripts/nodered_community_list_nodes');
const FLOW_SHA256 = '70b9350fedee6b0ab8555d0a47ebcbeb2c7d43ec7a241e3e7fafa8e40750cbf1';
const FUNCTION_PREIMAGES = Object.freeze({
  '634ddb4d82d27e9f': '540b1778f5223546e4efda5f55ae576605847ad2a3591f5d689ff6235b3152aa',
  '9ec08e9a627fa3e2': '54d5686d45a2f5230f936a191f3303cd50817709639af77222bfa07c838b53be',
});
const IDS = Object.freeze({
  tab: 'f7982bef49db88f7',
  route: '1c21ceed36fb7ba5',
  prepare: '634ddb4d82d27e9f',
  mongo: '43a65858ca194292',
  response: '9ec08e9a627fa3e2',
  httpResponse: '8ec761fa996c19af',
  debug: '72aedd3c4155b80b',
});

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const exact = (flow, id, type, name) => {
  const matches = flow.filter(node => node?.id === id);
  if (matches.length !== 1) fail(`Expected one node ${id}, found ${matches.length}`);
  const node = matches[0];
  if (node.type !== type || (name && node.name !== name)) fail(`Node identity changed: ${id}`);
  return node;
};
const assertEqual = (actual, expected, label) => {
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} changed`);
};
const replaceTail = (current, next, marker, label) => {
  const index = String(current).indexOf(marker);
  if (index < 0 || current.indexOf(marker, index + 1) >= 0) fail(`${label} marker changed`);
  if (!next.startsWith(marker) || !next.endsWith('\n')) fail(`${label} source is incomplete`);
  const candidate = `${current.slice(0, index)}${next}`;
  new Function('msg', candidate);
  return candidate;
};

export function synchronizeCommunitySummaryProjection(sourceFlow, sourceSha256, prepareTail, responseTail) {
  if (sourceSha256 !== FLOW_SHA256 || sourceFlow.length !== 4804) fail('Live flow preimage changed');
  const original = structuredClone(sourceFlow);
  const ids = original.map(node => node?.id);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) fail('Invalid flow node IDs');

  const tab = exact(sourceFlow, IDS.tab, 'tab', null);
  if (tab.label !== 'LK Communities' || tab.disabled === true) fail('Community tab changed');
  const route = exact(sourceFlow, IDS.route, 'http in', 'LK communities list');
  assertEqual([route.z, route.method, route.url, route.wires],
    [IDS.tab, 'get', '/lk/communities', [[IDS.prepare]]], 'Community list route');
  const prepare = exact(sourceFlow, IDS.prepare, 'function', 'Prepare communities list query');
  assertEqual([prepare.z, prepare.outputs, prepare.wires],
    [IDS.tab, 3, [[IDS.mongo], [IDS.httpResponse], [IDS.debug]]], 'Prepare function wiring');
  const mongo = exact(sourceFlow, IDS.mongo, 'mongodb4', 'Find communities');
  assertEqual([mongo.z, mongo.clientNode, mongo.collection, mongo.operation, mongo.output, mongo.wires],
    [IDS.tab, '4e820638cc39c730', 'lk_communities', 'find', 'toArray', [[IDS.response]]],
    'Mongo find contract');
  const response = exact(sourceFlow, IDS.response, 'function', 'Build communities list response');
  assertEqual([response.z, response.outputs, response.wires],
    [IDS.tab, 2, [[IDS.httpResponse], [IDS.debug]]], 'Response function wiring');
  for (const node of [prepare, response]) {
    if (sha256(node.func || '') !== FUNCTION_PREIMAGES[node.id]) fail(`Function preimage changed: ${node.id}`);
  }

  prepare.func = replaceTail(prepare.func, prepareTail, 'const listMode =', 'Prepare');
  response.func = replaceTail(response.func, responseTail, 'const ctx =', 'Response');

  const changedNodes = [];
  for (let index = 0; index < sourceFlow.length; index += 1) {
    const before = original[index];
    const after = sourceFlow[index];
    if (isDeepStrictEqual(before, after)) continue;
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(key => !isDeepStrictEqual(before[key], after[key]));
    if (![IDS.prepare, IDS.response].includes(after.id) || !isDeepStrictEqual(keys, ['func'])) {
      fail(`Unexpected flow change: ${after.id}`);
    }
    changedNodes.push(after.id);
  }
  assertEqual(changedNodes.sort(), [IDS.prepare, IDS.response].sort(), 'Changed node set');
  return { candidate: sourceFlow, changedNodes };
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function publishCommunitySummaryProjection({ workspace, output, report }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (verified.sourceSha256 !== FLOW_SHA256) fail('Fresh live flow differs from reviewed preimage');
  if (!path.isAbsolute(output) || !path.isAbsolute(report)) fail('Output paths must be absolute');
  const outDir = path.dirname(output);
  if (outDir !== path.dirname(report) || output === report || fs.existsSync(outDir)) {
    fail('Output and report must share one new directory');
  }
  const parent = fs.realpathSync(path.dirname(outDir));
  if (path.join(parent, path.basename(outDir)) !== outDir || isWithin(REPO_ROOT, outDir)
    || isWithin(verified.workspace, outDir)) fail('Output directory must be external and canonical');
  const sourceBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(sourceBytes) !== verified.sourceSha256) fail('Verified source changed before patch');
  const prepareTail = fs.readFileSync(path.join(SOURCE_DIR, 'fn_list_prepare_tail.js'), 'utf8');
  const responseTail = fs.readFileSync(path.join(SOURCE_DIR, 'fn_list_response_tail.js'), 'utf8');
  const result = synchronizeCommunitySummaryProjection(
    structuredClone(verified.source), verified.sourceSha256, prepareTail, responseTail,
  );
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`, 'utf8');
  const summary = {
    ok: true,
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(candidateBytes),
    prepareTailSha256: sha256(prepareTail),
    responseTailSha256: sha256(responseTail),
    sourceNodeCount: verified.source.length,
    candidateNodeCount: result.candidate.length,
    changedNodeIds: result.changedNodes,
    deploymentPerformed: false,
  };
  const stage = path.join(parent, `.${path.basename(outDir)}.stage-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(stage, path.basename(output)), candidateBytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(stage, path.basename(report)), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(stage, outDir);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--workspace', '--output', '--report'].includes(key) || !argv[i + 1] || args[key]) {
      fail(`Invalid argument ${key || ''}`);
    }
    args[key] = argv[i + 1];
  }
  if (!args['--workspace'] || !args['--output'] || !args['--report']) {
    fail('Usage: patch_live_community_summary_projection.mjs --workspace DIR --output FILE --report FILE');
  }
  publishCommunitySummaryProjection({
    workspace: args['--workspace'], output: args['--output'], report: args['--report'],
  });
}

#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  assertExternalWorkspace,
  assertFlowArray,
  sha256File,
  verifyWorkspace,
} from './verify_nodered_source_origin.mjs';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== 'build' && command !== 'validate') {
    fail(
      'Usage: node scripts/nodered_modular_flow.mjs <build|validate> '
      + '--workspace /absolute/external/workspace '
      + '(--source-tab-label LABEL | --source-tab-id ID)',
    );
  }

  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null || value.startsWith('--')) {
      fail(`Invalid argument: ${key ?? ''}`);
    }
    if (Object.hasOwn(values, key)) fail(`Duplicate argument: ${key}`);
    values[key] = value;
  }

  const allowed = new Set(['--workspace', '--source-tab-label', '--source-tab-id']);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) fail(`Unknown argument: ${key}`);
  }
  if (!values['--workspace']) fail('Missing --workspace');
  const selectors = [values['--source-tab-label'], values['--source-tab-id']].filter(Boolean);
  if (selectors.length !== 1) {
    fail('Exactly one of --source-tab-label or --source-tab-id is required');
  }
  return {
    command,
    workspace: values['--workspace'],
    sourceTabLabel: values['--source-tab-label'] ?? null,
    sourceTabId: values['--source-tab-id'] ?? null,
  };
}

function selectEnabledTab(source, { sourceTabLabel, sourceTabId }) {
  const tabs = source.filter((node) => node.type === 'tab');
  const matches = sourceTabId
    ? tabs.filter((tab) => tab.id === sourceTabId)
    : tabs.filter((tab) => String(tab.label ?? '') === sourceTabLabel);
  if (matches.length !== 1) {
    fail(`Source tab selector must match exactly one tab (matched ${matches.length})`);
  }
  if (matches[0].disabled === true) fail('Selected source tab is disabled');
  return matches[0];
}

function extractSelectedNodes(source, selector) {
  const sourceTab = selectEnabledTab(source, selector);
  const selectedNodes = source.filter((node) => node.type !== 'tab' && node.z === sourceTab.id);
  if (selectedNodes.length === 0) fail('Selected source tab has no nodes');
  assertFlowArray(selectedNodes, 'Selected Node-RED tab nodes');
  return { sourceTab, selectedNodes };
}

function httpInputs(nodes) {
  return nodes
    .filter((node) => node.type === 'http in')
    .map((node) => `${node.id}\u0000${node.method ?? ''}\u0000${node.url ?? ''}`)
    .sort();
}

function validateSelectedNodes(source, candidate, selector) {
  assertFlowArray(source);
  assertFlowArray(candidate, 'Node-RED nodes-only candidate');
  const { sourceTab, selectedNodes } = extractSelectedNodes(source, selector);
  const sourceById = new Map(selectedNodes.map((node) => [node.id, node]));
  const candidateById = new Map(candidate.map((node) => [node.id, node]));
  const checks = [];
  const add = (ok, name) => checks.push({ ok: Boolean(ok), name });

  add(candidate.every((node) => node.type !== 'tab'), 'tabNodesExcluded');
  add(candidate.every((node) => Boolean(node.z)), 'configNodesExcluded');
  add(candidate.every((node) => node.z === sourceTab.id), 'otherTabNodesExcluded');
  add(candidate.length === selectedNodes.length, 'selectedNodeCountPreserved');
  add(
    candidateById.size === sourceById.size
      && [...sourceById.keys()].every((id) => candidateById.has(id)),
    'selectedNodeIdsPreserved',
  );
  add(
    [...sourceById].every(([id, node]) => (
      candidateById.has(id) && JSON.stringify(candidateById.get(id)) === JSON.stringify(node)
    )),
    'nodeBodiesPreserved',
  );

  const candidateIds = new Set(candidate.map((node) => node.id));
  let brokenWires = 0;
  let brokenLinks = 0;
  for (const node of candidate) {
    if (Array.isArray(node.wires)) {
      for (const wire of node.wires) {
        if (!Array.isArray(wire)) continue;
        for (const targetId of wire) {
          if (!candidateIds.has(targetId)) brokenWires += 1;
        }
      }
    }
    if ((node.type === 'link in' || node.type === 'link out') && Array.isArray(node.links)) {
      for (const targetId of node.links) {
        if (!candidateIds.has(targetId)) brokenLinks += 1;
      }
    }
  }
  add(brokenWires === 0, 'wireTargetsPreserved');
  add(brokenLinks === 0, 'linkTargetsPreserved');
  add(
    JSON.stringify(httpInputs(candidate)) === JSON.stringify(httpInputs(selectedNodes)),
    'httpInputsPreserved',
  );

  return {
    ok: checks.every((entry) => entry.ok),
    checks,
    sourceTab: { id: sourceTab.id, label: sourceTab.label ?? '' },
    stats: {
      selectedNodeCount: selectedNodes.length,
      httpInputCount: httpInputs(selectedNodes).length,
      brokenWires,
      brokenLinks,
    },
  };
}

function writePrivateJson(filePath, value) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRedactedJson(filePath, description) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail(`${description} must contain valid JSON`);
  }
}

function pathsFor(workspace) {
  const buildDirectory = path.join(workspace, 'build');
  return {
    buildDirectory,
    candidatePath: path.join(buildDirectory, 'selected-tab.nodes.json'),
    reportPath: path.join(buildDirectory, 'validation.json'),
  };
}

function assertNoPartialBuild(workspace) {
  if (fs.readdirSync(workspace).some((name) => name.startsWith('.build-stage-'))) {
    fail('Partial Node-RED build staging directory exists');
  }
}

function assertPrivateArtifact(filePath, workspace, description) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    fail(`${description} must be a private, non-linked regular file`);
  }
  const canonical = fs.realpathSync(filePath);
  const relative = path.relative(workspace, canonical);
  if (canonical !== path.resolve(filePath) || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${description} must resolve inside the workspace`);
  }
}

function readExistingBuild(workspace) {
  assertNoPartialBuild(workspace);
  const paths = pathsFor(workspace);
  const stat = fs.lstatSync(paths.buildDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    fail('Node-RED build directory must be a private real directory');
  }
  const entries = fs.readdirSync(paths.buildDirectory).sort();
  if (JSON.stringify(entries) !== JSON.stringify(['selected-tab.nodes.json', 'validation.json'])) {
    fail('Node-RED build is partial or contains unexpected artifacts');
  }
  assertPrivateArtifact(paths.candidatePath, workspace, 'Node-RED nodes-only candidate');
  assertPrivateArtifact(paths.reportPath, workspace, 'Node-RED validation report');
  return paths;
}

function printSummary(sourceSha256, candidatePath, validation) {
  console.log(`sourceSha256=${sourceSha256}`);
  console.log(`candidateSha256=${sha256File(candidatePath)}`);
  console.log(`selectedNodeCount=${validation.stats.selectedNodeCount}`);
  console.log(`httpInputCount=${validation.stats.httpInputCount}`);
  console.log(`brokenWireCount=${validation.stats.brokenWires}`);
  console.log(`brokenLinkCount=${validation.stats.brokenLinks}`);
}

function build(options) {
  const verified = verifyWorkspace(options.workspace, { quiet: true });
  assertNoPartialBuild(verified.workspace);
  const paths = pathsFor(verified.workspace);
  if (fs.existsSync(paths.buildDirectory)) fail('Node-RED build output already exists');

  const { selectedNodes } = extractSelectedNodes(verified.source, options);
  const validation = validateSelectedNodes(verified.source, selectedNodes, options);
  if (!validation.ok) {
    const failed = validation.checks.filter((entry) => !entry.ok).map((entry) => entry.name);
    fail(`Node-RED nodes-only validation failed: ${failed.join(', ')}`);
  }

  const stageDirectory = path.join(verified.workspace, `.build-stage-${process.pid}`);
  fs.mkdirSync(stageDirectory, { mode: 0o700 });
  try {
    const stageCandidate = path.join(stageDirectory, 'selected-tab.nodes.json');
    const stageReport = path.join(stageDirectory, 'validation.json');
    writePrivateJson(stageCandidate, selectedNodes);
    writePrivateJson(stageReport, {
      formatVersion: 1,
      sourceSha256: verified.sourceSha256,
      candidateSha256: sha256File(stageCandidate),
      sourceTab: validation.sourceTab,
      validation,
    });
    fs.renameSync(stageDirectory, paths.buildDirectory);
  } catch (error) {
    fs.rmSync(stageDirectory, { recursive: true, force: true });
    throw error;
  }
  printSummary(verified.sourceSha256, paths.candidatePath, validation);
}

function validate(options) {
  const verified = verifyWorkspace(options.workspace, { quiet: true });
  const paths = readExistingBuild(verified.workspace);
  const candidate = readRedactedJson(paths.candidatePath, 'Node-RED nodes-only candidate');
  const report = readRedactedJson(paths.reportPath, 'Node-RED validation report');
  const validation = validateSelectedNodes(verified.source, candidate, options);
  const candidateSha256 = sha256File(paths.candidatePath);
  if (!validation.ok) {
    const failed = validation.checks.filter((entry) => !entry.ok).map((entry) => entry.name);
    fail(`Node-RED nodes-only validation failed: ${failed.join(', ')}`);
  }
  if (
    report?.formatVersion !== 1
    || report.sourceSha256 !== verified.sourceSha256
    || report.candidateSha256 !== candidateSha256
    || !isDeepStrictEqual(report.sourceTab, validation.sourceTab)
    || !isDeepStrictEqual(report.validation, validation)
  ) {
    fail('Node-RED validation report does not match current artifacts');
  }
  printSummary(verified.sourceSha256, paths.candidatePath, validation);
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    assertExternalWorkspace(options.workspace);
    if (options.command === 'build') build(options);
    else validate(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

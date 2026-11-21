import fs from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const approved = JSON.parse(fs.readFileSync(new URL('./legacy_startup_retirement/bindings.json', import.meta.url), 'utf8'));
const TYPES = Object.freeze({
  telegram_a: 'telegram bot', telegram_b: 'telegram bot', telegram_c: 'telegram bot', telegram_d: 'telegram bot',
  email_debug: 'debug', email_trigger: 'inject', email_send: 'email-send', email_transport: 'email-transport',
  counter_write: 'http request', counter_transform: 'function', counter_debug: 'debug', counter_trigger: 'inject',
  counter_read: 'http request', counter_builder: 'function',
});
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const retirementNodeHash = node => sha(JSON.stringify(canonical(node)));
const fail = code => { throw new Error(code); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function assertNoRuntimeLookup(source) {
  const filename = 'retained-node.js';
  const ast = ts.createSourceFile(filename, `function __retained(){\n${source}\n}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) fail('RETIREMENT_DYNAMIC_LOOKUP_REVIEW_REQUIRED');
  let checker;
  const property = n => ts.isPropertyAccessExpression(n) ? n.name.text
    : ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text : null;
  function isRegistryConstructorCall(n) {
    const api = n.parent, method = api.parent, call = method?.parent;
    return (ts.isPropertyAccessExpression(api) || ts.isElementAccessExpression(api)) && api.expression === n && property(api) === 'nodes'
      && method && (ts.isPropertyAccessExpression(method) || ts.isElementAccessExpression(method)) && method.expression === api
      && ['createNode', 'registerType'].includes(property(method)) && call && ts.isCallExpression(call) && call.expression === method;
  }
  function isLocalScalarConstant(n) {
    if (!checker) {
      const options = { allowJs: true, noLib: true, noResolve: true };
      const host = { ...ts.createCompilerHost(options), getSourceFile: name => name === filename ? ast : undefined,
        fileExists: name => name === filename, readFile: () => undefined };
      checker = ts.createProgram([filename], options, host).getTypeChecker();
    }
    const declarations = checker.getSymbolAtLocation(n)?.getDeclarations();
    if (declarations?.length !== 1 || !ts.isVariableDeclaration(declarations[0])) return false;
    const d = declarations[0], init = d.initializer;
    return Boolean(d.parent.flags & ts.NodeFlags.Const) && Boolean(init)
      && (ts.isStringLiteralLike(init) || ts.isNumericLiteral(init)
        || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(init.kind));
  }
  function visit(n) {
    if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === 'getNode') fail('RETIREMENT_DYNAMIC_LOOKUP_REVIEW_REQUIRED');
    if (ts.isIdentifier(n) && n.text === 'RED') {
      const p = n.parent;
      const propertyName = (ts.isPropertyAccessExpression(p) && p.name === n)
        || (ts.isPropertyAssignment(p) && p.name === n);
      const parameterDeclaration = ts.isParameter(p) && p.name === n;
      if (!propertyName && !parameterDeclaration && !isRegistryConstructorCall(n) && !isLocalScalarConstant(n)) fail('RETIREMENT_DYNAMIC_LOOKUP_REVIEW_REQUIRED');
    }
    if (ts.isStringLiteralLike(n) && n.text === 'RED') fail('RETIREMENT_DYNAMIC_LOOKUP_REVIEW_REQUIRED');
    ts.forEachChild(n, visit);
  }
  visit(ast);
}

// Offline only: no imports, provider calls, files written, deployment or credential operations.
// Bindings can be supplied for synthetic fixtures; production callers use the reviewed defaults.
export function composeLegacyStartupRetirement(sourceBytes, { expectedSourceSha256, bindings = approved } = {}) {
  if (!digest(expectedSourceSha256) || sha(sourceBytes) !== expectedSourceSha256) fail('RETIREMENT_SOURCE_DRIFT');
  let flow;
  try { flow = JSON.parse(Buffer.from(sourceBytes).toString('utf8')); } catch { fail('RETIREMENT_INVALID_FLOW'); }
  if (!Array.isArray(flow) || flow.some(n => !n || Array.isArray(n) || typeof n.id !== 'string' || !n.id.trim())
    || new Set(flow.map(n => n.id)).size !== flow.length) fail('RETIREMENT_INVALID_FLOW');
  if (!bindings || Object.keys(bindings).sort().join(',') !== Object.keys(TYPES).sort().join(',')) fail('RETIREMENT_BINDING_SET');
  const identities = new Set();
  const removedIds = new Set();
  const removed = [];
  for (const [role, type] of Object.entries(TYPES)) {
    const pin = bindings[role];
    if (!pin || pin.type !== type || !digest(pin.identityHash) || !digest(pin.nodeSha256) || identities.has(pin.identityHash)) fail('RETIREMENT_BINDING_INVALID');
    identities.add(pin.identityHash);
    const matches = flow.filter(n => sha(n.id) === pin.identityHash);
    if (matches.length !== 1 || matches[0].type !== type || retirementNodeHash(matches[0]) !== pin.nodeSha256) fail('RETIREMENT_NODE_DRIFT');
    removedIds.add(matches[0].id);
    removed.push({ role, identityHash: pin.identityHash, nodeSha256: pin.nodeSha256 });
  }
  const candidate = flow.filter(n => !removedIds.has(n.id));
  // Reject inbound wires, links, config consumers, subflow/env references and source literals.
  // No edge repair: the reviewed retirement cohort must be closed before removing any node.
  for (const n of candidate) {
    const serialized = JSON.stringify(n);
    if ([...removedIds].some(id => serialized.includes(id))) fail('RETIREMENT_EXTERNAL_REFERENCE');
    for (const key of ['func', 'initialize', 'finalize']) {
      if (typeof n[key] === 'string' && n[key]) assertNoRuntimeLookup(n[key]);
    }
  }
  // Every retained node stays byte-for-byte equivalent as a JSON value, including tabs,
  // HTTP inputs, all other Telegram configs, ordering, credentials and business functions.
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  return {
    candidate, candidateBytes,
    receipt: {
      formatVersion: 1, operation: 'legacy-startup-retirement', sourceSha256: expectedSourceSha256,
      candidateSha256: sha(candidateBytes), sourceNodeCount: flow.length, candidateNodeCount: candidate.length,
      removed, retainedNodesUnchanged: true, removedHttpInputCount: 0,
      dynamicLookupGate: 'parsed-no-runtime-RED-or-getNode-in-retained-function-lifecycle',
      deploymentAuthorized: false,
    },
  };
}

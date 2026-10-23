import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const OWNER_SOURCE_SHA256 = 'de181b4129ae480d0a0abddee85d72f2783ca4bcc9cdf61c9e3c82f1f66ce39d';
export const OWNER_UNITS = Object.freeze([
  ['router', 'lk_subscription_booking_router_20260804', 'fn_subscription_booking_router.js',
    '96055d0d36cb1c23bc5302ef697218667283d689',
    'ad423f72fdee9d76d11d141774d5f3e1588c35417e7edc5f28d1dd3bbf7dd5c4',
    '86b63d2f5e61c9046f31189c8f384ee6e6abfe5cf94c309cc51f7458d9aa1991'],
  ['prepare', 'lk_subscription_booking_prepare_20260804', 'fn_subscription_booking_prepare.js',
    '7309efb008624188bd6d2bdf351f2350510106ad',
    '0e5010a88954e100b70ff28b81b56abd8f2fad9a2b485e325c95d304777f762c',
    '1da7771e86ace8635488484059984b1ac93c2628c6edcb4b07b6a9fadb1bdc11'],
  ['policy', 'lk_subscription_managed_policy_20260820', 'fn_managed_subscription_policy_evaluate.js',
    '9303486b520d27bb632f9663069574f81f3080c4',
    '2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602',
    'a1fcb4f942fb265203ee7c7232fecf6b4eb9459ede5b174cc05bb2d28f1a8576'],
  ['finalize', 'lk_subscription_booking_finalize_20260804', 'fn_subscription_booking_finalize.js',
    '4ec1d6bca0b9e719dde492bfa67990141cd5b30c',
    '2b11541259acf223cbfa2fe8cc81ad268dc26213e4b171d1bd6726fa9515dc3d',
    'd9efac68af3287c9296d103581ba40e662e557768c784477ce2004cb979ca89c'],
  ['mongo-error', 'lk_subscription_booking_mongo_error_20260804', 'fn_subscription_booking_mongo_error.js',
    'c6140edb41531b4353ffa921702d35ed84bb0271',
    '87d3cf2937fe58e17fe48707ae5771d70a2150d636b9c129407bc1629724360a',
    '1c786def280a91c684dae8a71d56ac903ad1912f059145aa85d1dab0944f3a56'],
]);

// Statement identities keep installed wrappers out of line-merge alignment.
// This is one exact-preimage build, never a general upgrade of an unknown flow.
export function statements(source) {
  const file = ts.createSourceFile('owner.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw new Error('Owner source syntax drift');
  const rows = file.statements.map(node => {
    const body = node.getText(file);
    let key;
    if (ts.isVariableStatement(node)) key = `var:${node.declarationList.declarations.map(d => d.name.getText(file)).join(',')}`;
    else if (ts.isFunctionDeclaration(node)) key = `fn:${node.name?.text}`;
    else if (ts.isIfStatement(node)) key = `if:${node.expression.getText(file).replace(/\s+/g, ' ')}`;
    else if (ts.isExpressionStatement(node)) key = `expr:${node.expression.getText(file).split('\n')[0]}`;
    else key = `${ts.SyntaxKind[node.kind]}:${body}`;
    return { key, body, prefix: source.slice(node.getFullStart(), node.getStart(file)) };
  });
  if (new Set(rows.map(row => row.key)).size !== rows.length) throw new Error('Duplicate owner statement identity');
  return rows;
}

const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error('Owner compatibility anchor drift');
  return source.replace(before, () => after);
};

function conflict(key, live, canonical) {
  switch (key) {
    case 'var:prepareHttp':
    case 'var:PLAN_CATEGORIES': return canonical;
    case 'var:resolveCategory':
      return replaceOnce(live, '[4588].includes(directionId)', '[4588, 6180].includes(directionId)');
    case 'var:preparePreaccept':
    case 'var:prepareBookingCreate': return live + canonical;
    case 'if:ctx.step === "profile"': return live;
    case 'if:ctx.step === "exercise"': return live;
    case 'if:ctx.step === "operation_insert"':
      return live.slice(0, live.indexOf('\n') + 1) + canonical;
    default: throw new Error(`Unreviewed owner conflict: ${key}`);
  }
}

function mergeStatement(key, live, base, canonical, temporary) {
  for (const [name, body] of [['live', live], ['base', base], ['canonical', canonical]]) {
    fs.writeFileSync(path.join(temporary, name), body + '\n', { mode: 0o600 });
  }
  const result = spawnSync('git', ['merge-file', '--diff3', '-p', '-L', 'LIVE', '-L', 'BASE', '-L', 'CANONICAL',
    ...['live', 'base', 'canonical'].map(name => path.join(temporary, name))], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status === null || result.status < 0 || result.status > 127) {
    throw new Error('Local owner merge tool unavailable');
  }
  let count = 0;
  const merged = result.stdout.replace(/<<<<<<< LIVE\n([\s\S]*?)\|\|\|\|\|\|\| BASE\n[\s\S]*?=======\n([\s\S]*?)>>>>>>> CANONICAL\n/g,
    (_match, ours, theirs) => { count++; return conflict(key, ours, theirs); });
  if (count !== result.status || /^(?:<<<<<<<|=======|>>>>>>>|\|{7})/m.test(merged)) {
    throw new Error('Unresolved owner composition conflict');
  }
  return { body: merged.trimEnd(), conflictBlocks: count };
}

const tokens = source => {
  const file = ts.createSourceFile('guard.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parts = [];
  const visit = node => {
    const children = node.getChildren(file);
    if (children.length) children.forEach(visit);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.kind !== ts.SyntaxKind.SyntaxList) {
      parts.push(`${node.kind}:${node.getText(file)}`);
    }
  };
  visit(file);
  return '\0' + parts.join('\0') + '\0';
};
function childStatements(source) {
  const file = ts.createSourceFile('statement.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = file.statements[0];
  const body = ts.isVariableStatement(node)
    ? node.declarationList.declarations[0].initializer?.body : node.thenStatement;
  return body?.statements ? [...body.statements].map(child => child.getText(file)) : [];
}

function verifyRouterSemantics(original, rows) {
  const next = new Map(rows.map(row => [row.key, row]));
  const checks = [];
  const guards = [
    ['var:prepareHttp', /preflightReadOnlyHttp|lk1BindConfirmationRead/],
    ['var:preparePreaccept', /trialExercise|trialBookingGrant|ctx\.lk1/],
    ['var:prepareBookingCreate', /trialExercise|ctx\.lk1/],
    ['if:ctx.step === "exercise"', /isTopokraty|isProTraining|productRule|selectedRule|lk1MoneyReadbackPhase/],
    ['if:ctx.step === "exercise_recheck"', /ctx\.lk1|productRecheckReady/],
    ['if:ctx.step === "operation_insert"', /ctx\.lk1/],
    ['if:ctx.step === "booking_create"', /ctx\.lk1/],
    ['if:ctx.step === "operation_confirm"', /ctx\.lk1/],
  ];
  for (const [key, marker] of guards) {
    const preserved = childStatements(original.get(key).body).filter(text => marker.test(text));
    if (!preserved.length) throw new Error(`Missing installed guard: ${key}`);
    for (const fragment of preserved) {
      if (!tokens(next.get(key).body).includes(tokens(fragment))) throw new Error(`Installed guard lost: ${key}`);
      checks.push({ key, guardSha256: hash(fragment), preserved: true });
    }
  }
  const categories = source => new Function(source + '\nreturn PLAN_CATEGORIES;')();
  if (JSON.stringify(categories(original.get('var:PLAN_CATEGORIES').body))
    !== JSON.stringify(categories(next.get('var:PLAN_CATEGORIES').body))) throw new Error('Installed category policy changed');
  const http = next.get('var:prepareHttp').body;
  if (http.split('msg.followRedirects = false').length !== 2
    || http.split('msg.maxRedirects = 0').length !== 2) throw new Error('Ambiguous transport guard');
  const booking = next.get('var:prepareBookingCreate').body;
  if (!(booking.indexOf('trialBeginGate') < booking.indexOf('const runtimeConfig')
    && booking.indexOf('const runtimeConfig') < booking.indexOf('"POST"'))
    || booking.split('"POST"').length !== 2) throw new Error('Booking guard/environment/POST order drift');
  const confirm = next.get('if:ctx.step === "operation_confirm"').body;
  if (!(confirm.indexOf('prepareManagedEntitlementConfirm') < confirm.indexOf('prepareManagedFirstUseActivation')
    && confirm.indexOf('prepareManagedFirstUseActivation') < confirm.indexOf('finishConfirmed'))) {
    throw new Error('Entitlement/activation confirmation order drift');
  }
  return checks;
}

function graftSource(name, liveSource, baseSource, canonicalSource, temporary) {
  const live = statements(liveSource), base = new Map(statements(baseSource).map(row => [row.key, row]));
  const canonical = statements(canonicalSource), wanted = new Map(canonical.map(row => [row.key, row]));
  const original = new Map(live.map(row => [row.key, { ...row }]));
  const changed = [], added = [], resolutions = [];
  for (const row of live) {
    const before = base.get(row.key), next = wanted.get(row.key);
    if (!next || next.body === row.body || next.body === before?.body) continue;
    const priorBody = row.body;
    if (row.body === before?.body) row.body = next.body;
    else if (!before && row.key === 'var:findOwnedSubscriptions') {
      const raw = original.get('var:rawOwnedSubscriptions');
      if (next.body.replace('const findOwnedSubscriptions =', 'const rawOwnedSubscriptions =') !== raw?.body) {
        throw new Error('Exact product identity reader drift');
      }
      // Preserve the installed authenticated identity wrapper and its raw reader.
      resolutions.push({ key: row.key, decision: 'KEEP_AUTHENTICATED_PRODUCT_IDENTITY_WRAPPER' });
    } else if (!before && row.key === 'if:ctx.step === "prospective_subscriptions"') {
      row.body = next.body.replace('if (ctx.step === "prospective_subscriptions")',
        'if (ctx.step === "prospective_subscriptions" && ctx.caller === "split_create_preflight")')
        + '\n\n' + row.body;
      resolutions.push({ key: row.key, decision: 'SEPARATE_EXACT_CANONICAL_AND_LEGACY_CALLERS' });
    } else if (!before) throw new Error(`Unreviewed added owner statement: ${row.key}`);
    else {
      const merged = mergeStatement(row.key, row.body, before.body, next.body, temporary);
      row.body = merged.body;
      if (merged.conflictBlocks) resolutions.push({ key: row.key, conflictBlocks: merged.conflictBlocks,
        resolvedSha256: hash(row.body) });
    }
    if (row.body !== priorBody) changed.push(row.key);
  }
  const present = new Set(live.map(row => row.key));
  // Insert each canonical addition before its next existing canonical statement;
  // installed declaration/continuation order stays intact.
  for (let i = canonical.length - 1; i >= 0; i--) {
    const row = canonical[i];
    if (present.has(row.key)) continue;
    const following = canonical.slice(i + 1).find(next => present.has(next.key));
    const index = following ? live.findIndex(next => next.key === following.key) : live.length;
    live.splice(index, 0, { ...row }); present.add(row.key); added.push(row.key);
  }
  if (name === 'router') {
    const http = live.find(row => row.key === 'var:prepareHttp');
    http.body = replaceOnce(http.body,
      '  if (ctx.lk1 || ctx.lk1BeforeCreate || ctx.lk1ReadOnlyQuote) { msg.followRedirects = false; msg.maxRedirects = 0; }\n', '');
    const exercise = live.find(row => row.key === 'if:ctx.step === "exercise"');
    exercise.body = replaceOnce(exercise.body, 'if (ownedSubscriptions.length === 0)', 'if (ownedSubscriptions.length !== 1)');
    const recheck = live.find(row => row.key === 'if:ctx.step === "exercise_recheck"');
    recheck.body = replaceOnce(recheck.body, 'ownedSubscriptions.length === 0', 'ownedSubscriptions.length !== 1');
    const raw = live.find(row => row.key === 'var:rawOwnedSubscriptions');
    raw.body = replaceOnce(raw.body, 'if (explicitIds.length > 0) return explicitIds.includes(target);',
      'if (explicitIds.length > 0) return explicitIds.every(id => id === target);');
    raw.body = replaceOnce(raw.body, 'return [item.id, item.uuid].map(normalizeId).filter(Boolean).includes(target);',
      'const fallbackIds = [item.id, item.uuid].map(normalizeId).filter(Boolean);\n'
      + '      return fallbackIds.length > 0 && fallbackIds.every(id => id === target);');
    const reserve = live.find(row => row.key === 'if:ctx.step === "managed_entitlement_reserve"');
    reserve.body = replaceOnce(reserve.body, '  const result = unwrapRecord(msg.payload);',
      '  const result = unwrapRecord(msg.payload);\n'
      + '  const blockers = asArray(result?.blockers);\n'
      + '  const commonReceipt = result?.schemaVersion === 1\n'
      + '    && result.subscriptionInstanceId === (ctx.managedRuntime?.subscriptionInstanceId || ctx.managedSubscriptionInstanceId)\n'
      + '    && Number.isInteger(result.aggregateRevision) && result.aggregateRevision >= 1 && Array.isArray(result.blockers);\n'
      + '  const reservedReceipt = commonReceipt && result.outcome === "RESERVED" && toStr(result.operationId)\n'
      + '    && ["RESERVED", "CONFIRMED"].includes(result.operationState) && typeof result.replayed === "boolean"\n'
      + '    && (result.operationState !== "CONFIRMED" || result.replayed === true)\n'
      + '    && blockers.length === 0 && validEntitlementDecision(ctx, result.decision);\n'
      + '  const fullPriceReceipt = commonReceipt && result.outcome === "FULL_PRICE_WITHOUT_SUBSCRIPTION"\n'
      + '    && result.operationId === null && result.operationState === null && result.decision === null\n'
      + '    && blockers.length === 1 && blockers[0]?.code === "ACTIVE_SERVICES_LIMIT_REACHED";\n'
      + '  if (msg.error || !Number(msg.statusCode) || Number(msg.statusCode) === 408 || Number(msg.statusCode) >= 500\n'
      + '    || (isHttpOk(msg.statusCode) && !reservedReceipt && !fullPriceReceipt)) {\n'
      + '    return finishPending(ctx, "Результат резерва entitlement требует сверки", {\n'
      + '      code: "SUBSCRIPTION_ENTITLEMENT_RESERVE_RECONCILIATION_REQUIRED",\n'
      + '    });\n  }');
    changed.push(raw.key);
  }
  const preserved = live.filter(row => !wanted.has(row.key) && !base.has(row.key)
    && row.key !== 'var:rawOwnedSubscriptions');
  for (const row of preserved) {
    if (row.body !== original.get(row.key)?.body) throw new Error('Protected installed owner wrapper changed');
  }
  const source = live.map(row => row.prefix + row.body).join('') + '\n';
  new Function('msg', 'global', 'node', 'env', source);
  const semanticChecks = name === 'router' ? verifyRouterSemantics(original, live) : [];
  return { source, changed, added, resolutions, semanticChecks, protectedStatements: preserved.length };
}

export function graftOwnerFunctions(flow) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phub-join-owner-graft-'));
  try {
    const candidate = structuredClone(flow), reports = [];
    for (const [name, id, file, blob, liveHash, canonicalHash] of OWNER_UNITS) {
      const row = candidate.find(node => node.id === id);
      if (!row || row.type !== 'function' || hash(row.func) !== liveHash) throw new Error(`Owner ${name} preimage drift`);
      const canonical = fs.readFileSync(path.join(ROOT, 'scripts/nodered_subscription_booking_nodes', file), 'utf8');
      if (hash(canonical) !== canonicalHash) throw new Error(`Owner ${name} canonical source drift`);
      const base = execFileSync('git', ['cat-file', 'blob', blob], { cwd: ROOT, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
      const result = graftSource(name, row.func, base, canonical, temporary);
      row.func = result.source;
      reports.push({ id, name, sourceSha256: liveHash, candidateSha256: hash(row.func),
        changedStatements: result.changed, addedStatements: result.added,
        conflictResolutions: result.resolutions, semanticChecks: result.semanticChecks,
        protectedStatements: result.protectedStatements });
    }
    return { candidate, reports };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

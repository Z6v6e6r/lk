#!/usr/bin/env node
import crypto from 'node:crypto';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

export const SOURCE_SHA = '7775475aea2436ca5d6ec26cdc6acc4c682556f05b71af2fb79f6e0c0edbcb71';
export const AVAILABILITY_SHA = '9d99a77d9319c869ded3f8f05943a0bf00b4795a64fcb9aa6e7a275f02825df5';
export const COMPILER_VERSION = '5.9.3';
export const IDS = Object.freeze({ split: '8f7bd5b482fe9763', gateway: 'lk_subscription_booking_router_20260804', finalize: 'lk_subscription_booking_finalize_20260804' });
const dir = path.dirname(fileURLToPath(import.meta.url));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const snippet = name => fs.readFileSync(path.join(dir, 'nodered_subscription_create_preflight_nodes', name + '.js'), 'utf8');
export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Preflight source anchor drift');
  return source.replace(before, after);
}
export function patchSources(source) {
  const out = { ...source };
  const start = 'const continueSplitAfterVerifiedPrice = (ctx) => {\n  if (ctx.action === "create") {';
  out.split = replaceOnce(out.split, start, start + '\n' + snippet('split_start'));
  const token = 'if (ctx.step === "token") {';
  out.split = replaceOnce(out.split, token, `if (ctx.step === "subscription_create_preflight_complete") {
  if (ctx.action !== "create" || ctx.subscriptionCreatePreflightDone !== true || ctx.exerciseId) {
    return fail(409, "Контекст предварительной проверки потерян", { code: "SUBSCRIPTION_CREATE_PREFLIGHT_UNCONFIRMED" });
  }
  return continueSplitAfterVerifiedPrice(ctx);
}

` + token);
  const profile = '  return prepareUserGet(\n    ctx,\n    "exercise",';
  out.gateway = replaceOnce(out.gateway, profile, `  if (ctx.caller === "split_create_readonly_preflight") {
    return prepareUserGet(ctx, "prospective_subscriptions",
      \`/end-user/api/v1/\${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000\`);
  }
` + profile);
  const exercise = 'if (ctx.step === "exercise") {';
  out.gateway = replaceOnce(out.gateway, exercise, snippet('gateway_target') + '\n' + exercise);
  const find = 'const prepareOperationFind = (ctx, query = { _id: ctx.operationKey }) => {';
  out.gateway = replaceOnce(out.gateway, find, find + `
  if (ctx.caller === "split_create_readonly_preflight") {
    msg._subscriptionBooking = ctx;
    msg.statusCode = 200;
    msg.payload = { ok: true, state: "CREATE_PREFLIGHT_PASSED" };
    return emit(OUTPUT_FINAL);
  }`);
  const http = 'const prepareHttp = (ctx, step, method, url, payload, headers = {}) => {';
  out.gateway = replaceOnce(out.gateway, http, http + `
  if (ctx.caller === "split_create_readonly_preflight" && !preflightReadOnlyHttp({
    method, url, payload, _subscriptionBooking: { ...ctx, step },
  })) {
    return finishError(ctx, 409, "Предварительная проверка не разрешает запись", {
      code: "SUBSCRIPTION_CREATE_PREFLIGHT_WRITE_BLOCKED",
    });
  }`);
  const availabilitySource = fs.readFileSync(path.join(dir, '../src/components/games/splitSubscriptionAvailability.ts'), 'utf8');
  if (hash(availabilitySource) !== AVAILABILITY_SHA || ts.version !== COMPILER_VERSION) {
    throw new Error('Availability helper or compiler changed: new review required');
  }
  const availability = ts.transpileModule(availabilitySource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  if (/\brequire\s*\(/.test(availability)) throw new Error('Availability helper gained runtime dependencies');
  out.gateway = `const preflightAvailability = (() => { const exports = {}; \n${availability}\n return exports; })();\n` + out.gateway;
  out.gateway = `const preflightReadOnlyHttp = (value) => {
  if (value.method === "GET") return true;
  const context = value._subscriptionBooking;
  const base = (readGlobal("subscriptions_runtime_api_base_url") || "").replace(/\\/+$/, "");
  return value.method === "POST" && context?.step === "managed_runtime_context"
    && context.managedEnforcement?.enabled === true && context.planKey === "piter_friendship"
    && /^https:\\/\\//i.test(base)
    && value.url === base + "/internal/subscriptions/runtime-context"
    && isObj(value.payload) && Object.keys(value.payload).length === 1
    && value.payload.clientSubscriptionId === context.clientSubscriptionId;
};
` + out.gateway;
  const emit = 'const emit = (index, value = msg) => {';
  out.gateway = replaceOnce(out.gateway, emit, emit + `
  if (value._subscriptionBooking?.caller === "split_create_readonly_preflight"
    && ([1, 2, 3].includes(index) || (index === 0 && !preflightReadOnlyHttp(value)))) {
    value.statusCode = 409;
    value.payload = { error: "Предварительная проверка не разрешает операции базы",
      details: { code: "SUBSCRIPTION_CREATE_PREFLIGHT_WRITE_BLOCKED" } };
    return [null, null, null, null, value, null, null];
  }`);
  const confirmed = 'if (ctx?.caller === "split" && payload.state === "CONFIRMED" && payload.bookingId) {';
  out.finalize = replaceOnce(out.finalize, confirmed, snippet('finalize') + '\n' + confirmed);
  for (const value of Object.values(out)) new Function('msg', 'node', 'env', 'global', value);
  return out;
}
export function buildCandidate(workspace) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (verified.sourceSha256 !== SOURCE_SHA) throw new Error('Live flow changed: new review required');
  const flow = structuredClone(verified.source);
  const sources = Object.fromEntries(Object.entries(IDS).map(([key, id]) => {
    const nodes = flow.filter(n => n.id === id && n.type === 'function');
    if (nodes.length !== 1) throw new Error('Missing target function');
    return [key, nodes[0].func];
  }));
  const ids = new Set(flow.map(n => n.id));
  if (ids.size !== flow.length || flow.some(n => [
    ...(n.wires || []).flat(), ...(['link in', 'link out'].includes(n.type) ? n.links || [] : []),
  ].some(id => !ids.has(id)))) throw new Error('Invalid flow topology');
  const patched = patchSources(sources);
  for (const [key, id] of Object.entries(IDS)) flow.find(n => n.id === id).func = patched[key];
  const changes = flow.filter((n, i) => !isDeepStrictEqual(n, verified.source[i]));
  if (changes.length !== 3 || changes.some(n => {
    const original = verified.source.find(old => old.id === n.id);
    return !isDeepStrictEqual({ ...n, func: original.func }, original);
  })) throw new Error('Change budget exceeded');
  return { flow, changes: changes.map(n => ({ id: n.id, fields: ['func'], sha256: hash(n.func) })),
    sourceSha256: verified.sourceSha256, nodeCount: flow.length,
    httpRouteCount: flow.filter(n => n.type === 'http in').length,
    availabilitySha256: AVAILABILITY_SHA, typescriptVersion: ts.version };
}
export function runBuild(workspace, outputDirectory) {
  const result = buildCandidate(workspace);
  const output = path.resolve(outputDirectory);
  const repo = fs.realpathSync(path.join(dir, '..'));
  if (!path.isAbsolute(outputDirectory) || output.startsWith(repo + path.sep)
    || output === repo || fs.existsSync(output) || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) {
    throw new Error('Use a new canonical external output directory');
  }
  fs.mkdirSync(output, { mode: 0o700 });
  const candidate = JSON.stringify(result.flow, null, 2) + '\n';
  fs.writeFileSync(path.join(output, 'candidate.json'), candidate, { mode: 0o600, flag: 'wx' });
  const report = { ...result, flow: undefined, candidateSha256: hash(candidate),
    deploymentPerformed: false, liveMutationPerformed: false,
    scope: 'read-only subscription preflight; late failure reconciliation, no automatic deletion' };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: <fresh-live-workspace> <new-external-output-directory>');
    console.log(JSON.stringify(runBuild(process.argv[2], process.argv[3])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

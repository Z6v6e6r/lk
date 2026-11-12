import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { applyPreview363Body, PREVIEW363_TARGET, PREVIEW363_HOOK, PREVIEW363_FUNCTION_SHA } from './preview363_body_patch.mjs';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const PREVIEW363_FLOW_SHA = '946720e396b97abeb29bb5a8f71dc29fab28c57410aff1f80a1c48588ea299fb';
const INITIALIZE = '41e10f67f5f966e3a28e29cc15f8b5e60af2ec9063d435faf9bfa425be67a89a';
const FINALIZE = '8ed42bff21b56b50ee1926385981d76c626f6d5402a99e592660e00ad5d38df1';
export function buildPreview363Artifact(sourceCommit, bundle = fs.readFileSync(new URL('../diagnostics/preview-empty-tariff-observer.bundle.cjs', import.meta.url), 'utf8')) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || '') || typeof bundle !== 'string' || !bundle.trim()) throw Error('PREVIEW363_RELEASE');
  const marker = { event: 'preview_empty_tariff_observer_ready', release: sourceCommit,
    sourceHash: PREVIEW363_FUNCTION_SHA, bundleSha256: sha256(bundle) };
  const prefix = `// Scoped PR363 empty-tariff observer.\ntry {\n  const prior = globalThis.__lkPreview350Observer;\n  if (prior?.owner === 'preview-cross-day-v1' && prior.preview363 !== true) {\n    let tariff = null;\n    try {\n      tariff = (() => {\n      const module = { exports: {} };\n      const require = name => {\n        if (name === 'node:crypto') return preview350Crypto;\n        if (name === 'node:perf_hooks') return preview350Performance;\n        throw Error('PREVIEW363_MODULE_REFUSED');\n      };\n${bundle}\n      return module.exports.createScopedEmptyTariffObserver({ release: '${sourceCommit}', sourceHash: '${PREVIEW363_FUNCTION_SHA}',\n        sink: event => node.warn(new Date().toISOString() + ' ' + JSON.stringify({ event: 'preview_empty_tariff_guard_diagnostic', ...event })) });\n      })();\n    } catch { /* Existing cross-day observation remains available. */ }\n    const installed = tariff;\n    globalThis.__lkPreview350Observer = Object.freeze({ owner: 'preview-cross-day-v1', preview363: true,\n      observe(msg, stage, fields) {\n        if (fields?.code === 'PREVIEW_EMPTY_TARIFF_OBSERVED') installed?.observe(msg, stage, fields);\n        else prior.observe(msg, stage, fields);\n      },\n      snapshot: () => prior.snapshot(),\n      dispose() { try { installed?.dispose(); } finally { prior.dispose(); } },\n    });\n    try { node.warn(new Date().toISOString() + ' ' + JSON.stringify(installed ? ${JSON.stringify(marker)} : { event: 'preview_empty_tariff_observer_unavailable' })); } catch { /* no-throw */ }\n  }\n} catch { /* Optional bootstrap cannot alter business execution. */ }\n`;
  return { prefix, hook: PREVIEW363_HOOK };
}
export function patchPreview363Flow(flow, { sourceCommit, bundle, expectedNodeCount = 4985,
  expectedFunctionSha256 = PREVIEW363_FUNCTION_SHA, expectedInitializeSha256 = INITIALIZE,
  expectedFinalizeSha256 = FINALIZE } = {}) {
  if (!Array.isArray(flow) || flow.length !== expectedNodeCount || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('PREVIEW363_GRAPH');
  const candidate = structuredClone(flow), node = candidate.find(n => n.id === PREVIEW363_TARGET);
  if (!node || node.type !== 'function' || node.d === true || candidate.find(n => n.id === node.z)?.disabled === true
    || sha256(node.func) !== expectedFunctionSha256 || sha256(node.initialize || '') !== expectedInitializeSha256
    || sha256(node.finalize || '') !== expectedFinalizeSha256
    || JSON.stringify(node.libs) !== JSON.stringify([{ var: 'preview350Crypto', module: 'crypto' }, { var: 'preview350Performance', module: 'perf_hooks' }])) throw Error('PREVIEW363_NODE_DRIFT');
  const before = node.func, artifact = buildPreview363Artifact(sourceCommit, bundle);
  node.func = applyPreview363Body(before, artifact);
  if (applyPreview363Body(node.func, artifact, true) !== before) throw Error('PREVIEW363_BUSINESS_DRIFT');
  new Function(node.func);
  return { candidate, artifact, targetId: PREVIEW363_TARGET, beforeFunctionSha256: sha256(before), afterFunctionSha256: sha256(node.func) };
}

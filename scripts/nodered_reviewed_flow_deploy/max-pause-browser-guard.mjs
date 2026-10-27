import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const coreFile = new URL('./max-pause-body-preserver.mjs', import.meta.url);
const coreSha256 = '52167f7caa49d0abc5195146954a346a322326554b2dec580a6954f7836818be';

// Build an origin-scoped, temporary page guard. No request is sent by this module.
// It forwards only the editor's original XHR, preserving its native credentials.
// Close the dedicated agent tab after reconciliation; the user's tab is untouched.
export async function buildMaxPauseBrowserGuard() {
  let core = await readFile(coreFile, 'utf8');
  if (createHash('sha256').update(core).digest('hex') !== coreSha256) throw new Error('MAX_GUARD_CORE_DRIFT');
  const replaceOnce = (before, after) => {
    if (core.split(before).length !== 2) throw new Error('MAX_GUARD_BUILD_DRIFT');
    core = core.replace(before, after);
  };
  replaceOnce("import crypto from 'node:crypto';", '');
  replaceOnce("const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');", "const hash = async (value) => [...new Uint8Array(await view.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');");
  replaceOnce('export const codePointGraphSha256', 'const codePointGraphSha256');
  replaceOnce('export function createMaxPauseBodyPreserver', 'async function createMaxPauseBodyPreserver');
  replaceOnce('codePointGraphSha256(source) !==', '(await codePointGraphSha256(source)) !==');
  replaceOnce('return ({ request, postBody }) =>', 'return async ({ request, postBody }) =>');
  replaceOnce('hash(postBody.rev) !==', '(await hash(postBody.rev)) !==');
  replaceOnce('postBodyCodePointSha256: codePointGraphSha256(body)', 'postBodyCodePointSha256: await codePointGraphSha256(body)');
  replaceOnce('forwardedBodySha256: hash(postDataText)', 'forwardedBodySha256: await hash(postDataText)');
  return `(async function installMaxPauseBrowserGuard(seal) {
    'use strict';
    if (arguments.length !== 1) throw new Error('MAX_GUARD_ARGUMENTS');
    const view = window;
    if (view.top !== view) throw new Error('MAX_GUARD_REALM');
    const installedAt = Date.now(), startedAt = performance.now(), notAfter = seal.notAfter;
    const deadline = typeof notAfter === 'string' ? Date.parse(notAfter) : NaN;
    if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== notAfter || deadline <= installedAt || deadline - installedAt > 600000) throw new Error('MAX_GUARD_EXPIRY');
    const expired = () => Date.now() >= deadline || performance.now() - startedAt >= deadline - installedAt;
    ${core}
    const target = 'http://127.0.0.1:18801/flows';
    if (view.location.origin !== new URL(target).origin) throw new Error('MAX_GUARD_ORIGIN');
    const proto = view.XMLHttpRequest.prototype;
    const marker = Symbol.for('padlhub.max.pause.guard.v1');
    if (Object.hasOwn(proto, marker)) throw new Error('MAX_GUARD_ALREADY_INSTALLED');
    Object.defineProperty(proto, marker, { value: true });
    const run = await createMaxPauseBodyPreserver(seal);
    if (expired()) throw new Error('MAX_GUARD_EXPIRED');
    const nativeOpen = proto.open, nativeHeader = proto.setRequestHeader;
    const nativeSend = proto.send, nativeAbort = proto.abort, nativeFetch = view.fetch;
    const states = new WeakMap();
    let used = false, audit = { operationId: seal.operationId, state: 'ARMED', forwarded: 0, rejected: 0 };
    const flowUrl = value => new URL(value, view.location.href);
    const isFlow = url => url.pathname.replace(/\\/+$/, '') === '/flows';
    const reject = () => { audit = { ...audit, state: 'BLOCKED', rejected: audit.rejected + 1 }; };
    proto.open = function(method, url, ...rest) {
      const previous = states.get(this);
      if (previous) previous.cancelled = true;
      // Node-RED uses primitive strings. Reject unknown coercions before native I/O.
      if (typeof method !== 'string' || typeof url !== 'string') throw new Error('MAX_GUARD_OPEN_TYPE');
      // Installed Node-RED vendor jQuery always supplies five arguments, with
      // undefined username/password. Preserve that exact native shape only.
      const nativeShape = rest.length === 0 || (rest.length === 1 && rest[0] === true) || (rest.length === 3 && rest[0] === true && rest[1] === undefined && rest[2] === undefined);
      if (!nativeShape) throw new Error('MAX_GUARD_OPEN_AUTHORITY');
      const parsed = flowUrl(url);
      const record = { method: method.toUpperCase(), url: parsed.href, flow: isFlow(parsed), sent: false, cancelled: false, headers: {}, invalid: false };
      states.set(this, record);
      // Native open synchronously emits readystatechange. Its handler may call
      // send/open before nativeOpen returns, so publish the guard state first.
      try { return Reflect.apply(nativeOpen, this, [method, url, ...rest]); }
      catch (error) {
        record.cancelled = true;
        if (states.get(this) === record) states.delete(this);
        throw error;
      }
    };
    proto.setRequestHeader = function(name, value) {
      const record = states.get(this);
      if (record?.sent) throw new Error('MAX_GUARD_HEADERS_LOCKED');
      if (typeof name !== 'string') throw new Error('MAX_GUARD_HEADER_NAME');
      const key = name.toLowerCase();
      // Do not read, coerce, store or return Authorization/cookie/header values.
      if (record?.flow && ['node-red-api-version', 'node-red-deployment-type'].includes(key)) {
        if (Object.hasOwn(record.headers, key) || typeof value !== 'string') record.invalid = true;
        else record.headers[key] = value;
      }
      return Reflect.apply(nativeHeader, this, [name, value]);
    };
    proto.abort = function(...args) {
      const record = states.get(this);
      if (record) record.cancelled = true;
      return Reflect.apply(nativeAbort, this, args);
    };
    proto.send = function(body) {
      const record = states.get(this);
      if (!record) throw new Error('MAX_GUARD_UNTRACKED_XHR');
      if (!record.flow || ['GET', 'HEAD'].includes(record.method)) return Reflect.apply(nativeSend, this, [body]);
      if (record.sent || used) { reject(); throw new Error('MAX_GUARD_CONSUMED'); }
      used = true; record.sent = true; audit = { ...audit, state: 'VALIDATING' };
      if (expired()) { record.cancelled = true; reject(); Reflect.apply(nativeAbort, this, []); throw new Error('MAX_GUARD_EXPIRED'); }
      const xhr = this;
      // The closure remains installed if CDP disconnects. No paused request can
      // escape with the original body, and no replacement HTTP client is used.
      void (async () => {
        try {
          if (record.invalid || typeof body !== 'string' || body.length > 16000000) throw new Error('MAX_GUARD_BODY');
          const output = await run({ request: { url: record.url, method: record.method, apiVersion: record.headers['node-red-api-version'], deploymentType: record.headers['node-red-deployment-type'] }, postBody: JSON.parse(body) });
          if (states.get(xhr) !== record || record.cancelled || expired()) throw new Error('MAX_GUARD_CANCELLED');
          // Last fence and native send are synchronous; open/abort cannot race.
          Reflect.apply(nativeSend, xhr, [output.postDataText]);
          audit = { ...audit, ...output.audit, state: 'FORWARDED_AWAITING_READBACK', forwarded: 1 };
        } catch {
          reject();
          if (states.get(xhr) === record) {
            record.cancelled = true;
            Reflect.apply(nativeAbort, xhr, []);
          }
        }
      })();
    };
    if (typeof nativeFetch === 'function') view.fetch = function(input, options) {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      const method = options?.method ?? (typeof input === 'object' ? input.method : undefined) ?? 'GET';
      if (typeof url !== 'string' || typeof method !== 'string') return Promise.reject(new Error('MAX_GUARD_FETCH_TYPE'));
      if (isFlow(flowUrl(url)) && !['GET', 'HEAD'].includes(method.toUpperCase())) {
        used = true; reject(); return Promise.reject(new Error('MAX_GUARD_FETCH_FORBIDDEN'));
      }
      return Reflect.apply(nativeFetch, this, [input, options]);
    };
    return Object.freeze({ status: () => structuredClone({ ...audit, notAfter, ...(audit.state === 'ARMED' && expired() ? { state: 'EXPIRED' } : {}) }) });
  })`;
}

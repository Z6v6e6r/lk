/* global window */
/** Seal one original palette upload. Authentication headers and response bodies stay native. */
export function buildSupportAdapterUploadGuard() {
  return `(${installSupportAdapterUploadGuard.toString()})`;
}

export function buildSupportAdapterEditorReadback() {
  return `(${readSupportAdapterEditor.toString()})`;
}

async function readSupportAdapterEditor() {
  const view = window;
  if (view.top !== view || view.location.origin !== 'http://127.0.0.1:18801'
    || typeof view.jQuery?.ajax !== 'function' || typeof view.RED?.nodes?.createCompleteNodeSet !== 'function'
    || typeof view.RED.nodes.dirty !== 'function' || view.RED.nodes.dirty()
    || typeof view.RED.nodes.version !== 'function' || !view.RED.nodes.version()) throw Error('ADAPTER_EDITOR_NOT_READY');
  const version = view.RED.nodes.version(), requestedAt = new Date().toISOString();
  const get = (url, headers) => new Promise((resolve, reject) => view.jQuery.ajax({ url, method: 'GET', headers,
    dataType: 'json', timeout: 30000, success: resolve, error: () => reject(Error('ADAPTER_EDITOR_READ_REFUSED')) }));
  const snapshot = await get('flows', { 'Node-RED-API-Version': 'v2' });
  const sets = await get('nodes', { Accept: 'application/json' });
  if (!snapshot || Object.keys(snapshot).sort().join(',') !== 'flows,rev' || !Array.isArray(snapshot.flows)
    || snapshot.rev !== version || !Array.isArray(sets) || !snapshot.flows.length
    || view.RED.nodes.version() !== version || view.RED.nodes.dirty()) throw Error('ADAPTER_EDITOR_CHANGED');
  const editor = structuredClone(view.RED.nodes.createCompleteNodeSet());
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  const digest = async value => [...new Uint8Array(await view.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(n => n.toString(16).padStart(2, '0')).join('');
  const module = 'node-red-contrib-padlhub-max-outbox', found = sets.filter(row => row?.module === module);
  let adapter = null;
  if (found.length) {
    if (found.some(row => row.id !== module + '/' + row.name || !Array.isArray(row.types))) throw Error('ADAPTER_EDITOR_REGISTRY_SHAPE');
    adapter = { name: module, version: found[0].version, nodeSets: found.map(row => ({ name: row.name,
      enabled: row.enabled, types: row.types, error: Object.hasOwn(row, 'err'), pending: Object.hasOwn(row, 'pending_version') })) };
    if (found.some(row => row.version !== adapter.version)) throw Error('ADAPTER_EDITOR_REGISTRY_SHAPE');
  }
  const hashes = { revisionSha256: await digest(snapshot.rev),
    graphSha256: await digest(JSON.stringify([...snapshot.flows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(canonical))),
    orderedGraphSha256: await digest(JSON.stringify(snapshot.flows.map(canonical))),
    editorOrderedGraphSha256: await digest(JSON.stringify(editor.map(canonical))) };
  if (view.RED.nodes.version() !== version || view.RED.nodes.dirty()) throw Error('ADAPTER_EDITOR_CHANGED');
  return Object.freeze({ origin: view.location.origin, requestedAt, observedAt: new Date().toISOString(),
    count: snapshot.flows.length, dirty: false, revisionMatchesEditor: true, ...hashes, adapter });
}

async function installSupportAdapterUploadGuard(seal) {
  const view = window, origin = 'http://127.0.0.1:18801';
  const fail = code => { throw Error(code); };
  const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  const expectedKeys = ['attemptSha256', 'deadline', 'fileName', 'fileSha256', 'fileSize', 'nonce', 'planSha256'];
  if (view.top !== view || view.location.origin !== origin || !seal || Object.keys(seal).sort().join(',') !== expectedKeys.sort().join(',')
    || !hex(seal.planSha256) || !hex(seal.attemptSha256) || !hex(seal.fileSha256)
    || !/^[a-f0-9-]{36}$/.test(seal.nonce) || seal.fileName !== 'node-red-contrib-padlhub-max-outbox-1.1.0.tgz'
    || !Number.isSafeInteger(seal.fileSize) || seal.fileSize < 1 || seal.fileSize > 262144
    || !Number.isSafeInteger(seal.deadline) || seal.deadline <= Date.now() || seal.deadline - Date.now() > 300000) fail('ADAPTER_UPLOAD_SEAL');
  const frozen = structuredClone(seal), marker = 'padlhub-support-adapter-upload:' + frozen.attemptSha256;
  if (Object.hasOwn(view, '__supportAdapterUploadAudit')
    || Object.hasOwn(view, '__supportAdapterUploadCancel')) fail('ADAPTER_UPLOAD_CONSUMED');
  if (typeof view.navigator?.locks?.request !== 'function' || !view.localStorage) fail('ADAPTER_UPLOAD_DURABLE_CAPABILITY');
  await view.navigator.locks.request(marker, { ifAvailable: true }, lock => {
    if (!lock || view.localStorage.getItem(marker) !== null) fail('ADAPTER_UPLOAD_CONSUMED');
    view.localStorage.setItem(marker, 'ARMED:' + frozen.attemptSha256);
    if (view.localStorage.getItem(marker) !== 'ARMED:' + frozen.attemptSha256) fail('ADAPTER_UPLOAD_STORAGE');
  });
  if (Object.hasOwn(view, '__supportAdapterUploadAudit') || Object.hasOwn(view, '__supportAdapterUploadCancel')) fail('ADAPTER_UPLOAD_CONSUMED');
  const XHR = view.XMLHttpRequest, proto = XHR.prototype, originalOpen = proto.open, originalSend = proto.send,
    originalAbort = proto.abort, originalFetch = view.fetch, arrayBuffer = view.Blob.prototype.arrayBuffer;
  const records = new WeakMap(), deadline = performance.now() + (frozen.deadline - Date.now());
  const audit = { planSha256: frozen.planSha256, attemptSha256: frozen.attemptSha256, fileSha256: frozen.fileSha256,
    nonce: frozen.nonce, forwarded: 0, rejected: 0, terminal: false, httpStatus: null, cancelledBeforeForward: false };
  let consumed = false, stopped = false;
  const complete = (xhr, record, status) => {
    if (record.finished) return;
    record.finished = true; audit.terminal = true;
    audit.httpStatus = records.get(xhr) === record && !record.cancelled ? status : 0;
  };
  const write = (url, method) => {
    const u = new URL(String(url), origin);
    return u.origin === origin && !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
  };
  proto.open = function (method, url, ...rest) {
    const prior = records.get(this);
    if (prior) {
      prior.cancelled = true;
      if (prior.forwarded) {
        prior.finished = true; audit.terminal = true; audit.httpStatus = 0;
      }
    }
    records.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), origin), cancelled: false, finished: false });
    return originalOpen.call(this, method, url, ...rest);
  };
  proto.abort = function (...args) {
    const record = records.get(this);
    if (record) { record.cancelled = true; if (record.forwarded) complete(this, record, 0); }
    return originalAbort.apply(this, args);
  };
  proto.send = function (body) {
    const record = records.get(this);
    const reject = () => { audit.rejected++; originalAbort.call(this); };
    if (!record) { reject(); return; }
    if (!write(record.url.href, record.method)) return originalSend.call(this, body);
    if (stopped || consumed || record.method !== 'POST' || record.url.pathname !== '/nodes' || record.url.search || record.url.hash
      || !(body instanceof view.FormData) || performance.now() > deadline) { reject(); return; }
    consumed = true;
    const entries = [...body.entries()], file = entries[0]?.[1];
    if (entries.length !== 1 || entries[0][0] !== 'tarball' || !(file instanceof view.File)
      || file.name !== frozen.fileName || file.size !== frozen.fileSize) { reject(); return; }
    Promise.resolve().then(async () => {
      const bytes = await arrayBuffer.call(file);
      const hash = [...new Uint8Array(await view.crypto.subtle.digest('SHA-256', bytes))]
        .map(n => n.toString(16).padStart(2, '0')).join('');
      const current = [...body.entries()];
      if (hash !== frozen.fileSha256 || stopped || record.cancelled || records.get(this) !== record || performance.now() > deadline
        || current.length !== 1 || current[0][0] !== 'tarball' || current[0][1] !== file) { reject(); return; }
      if (view.localStorage.getItem(marker) !== 'ARMED:' + frozen.attemptSha256) { reject(); return; }
      view.localStorage.setItem(marker, 'SENT:' + frozen.attemptSha256);
      audit.forwarded = 1; record.forwarded = true;
      this.addEventListener('load', () => complete(this, record, this.status || 0), { once: true });
      for (const event of ['error', 'timeout', 'abort']) this.addEventListener(event, () => {
        complete(this, record, 0);
      }, { once: true });
      originalSend.call(this, body);
    }).catch(() => { reject(); });
  };
  view.fetch = function (input, options) {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    if (write(url, options?.method || input?.method)) return Promise.reject(Error('ADAPTER_UPLOAD_NATIVE_XHR_ONLY'));
    return originalFetch.apply(this, arguments);
  };
  Object.defineProperty(view, '__supportAdapterUploadAudit', { value: () => Object.freeze(structuredClone(audit)) });
  Object.defineProperty(view, '__supportAdapterUploadCancel', { value: () => {
    if (audit.forwarded) fail('ADAPTER_UPLOAD_POST_MAY_HAVE_EFFECT');
    stopped = true; audit.cancelledBeforeForward = true;
    return Object.freeze(structuredClone(audit));
  } });
  return Object.freeze({ status: 'ARMED', planSha256: frozen.planSha256, attemptSha256: frozen.attemptSha256 });
}

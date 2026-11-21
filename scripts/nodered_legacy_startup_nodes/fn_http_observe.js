// Observation only: never parse/coerce provider objects, update caches, or retry requests.
const observationStage = "response";
const nodeIdentityHash = "8ac9af17aba6fcd08abaf24f4a508bae8199905360c8f9ff57af80e61a1bc247";
const sourceFingerprint = "a89b5e56889d3579f091a68c96c6630559ef1723691b68100e66f1b6dda00ab7";
try {
    const now = Date.now();
    const key = 'legacyStartupHttpObservationV1';
    let state = context.get(key);
    const validCount = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
    if (!state || !Number.isFinite(state.start) || !validCount(state.count) || !validCount(state.suppressed)
        || now < state.start || now - state.start >= 60000) {
        const suppressed = state && validCount(state.suppressed) ? state.suppressed : 0;
        state = { start: now, count: 0, suppressed: 0, priorSuppressed: suppressed };
    }
    if (state.count >= 10) {
        state.suppressed = Math.min(2147483647, state.suppressed + 1);
        context.set(key, state);
    } else {
        state.count += 1;
        context.set(key, state);
        const payload = msg.payload;
        const isBuffer = typeof Buffer !== 'undefined' && Buffer.isBuffer(payload);
        const payloadKind = payload === null ? 'null' : isBuffer ? 'buffer' : Array.isArray(payload) ? 'array'
            : typeof payload === 'string' ? (payload.length === 0 ? 'empty' : 'string')
            : ['object', 'number', 'boolean', 'undefined'].includes(typeof payload) ? typeof payload : 'other';
        const length = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : isBuffer ? payload.length : null;
        const lengthBucket = length === null ? 'unknown' : length === 0 ? 'zero' : length <= 128 ? '1-128'
            : length <= 1024 ? '129-1024' : length <= 16384 ? '1025-16384' : 'over-16384';
        const ct = msg.headers && (msg.headers['content-type'] || msg.headers['Content-Type']);
        const mediaType = typeof ct === 'string' ? ct.split(';', 1)[0].trim().toLowerCase() : null;
        const contentTypeClass = mediaType === null ? 'unknown' : /^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mediaType) ? 'json'
            : mediaType === 'text/html' ? 'html' : /^text\//.test(mediaType) ? 'text' : 'other';
        const status = msg.statusCode;
        // HTTP request 4.x may return err.code in statusCode without msg.error.
        // Catch messages need not retain error.code. Never inspect/export error.message.
        const errorCode = msg.error && msg.error.code;
        const knownCodes = ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE',
            'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT'];
        const code = knownCodes.includes(errorCode) ? errorCode : knownCodes.includes(status) ? status : null;
        const transportClass = ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code) ? 'timeout'
            : ['ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 'dns'
            : ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(code) ? 'connection'
            : ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code) ? 'tls'
            : msg.error || observationStage === 'transport_error' || (typeof status === 'string' && status.length > 0) ? 'other' : 'none';
        const event = {
            schemaVersion: 1, code: 'LEGACY_STARTUP_HTTP_OBSERVATION', component: 'legacy_startup_http',
            observerVersion: 'v1', nodeIdentityHash, sourceFingerprint, stage: observationStage,
            httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
            contentTypeClass, payloadKind, observedPayloadLengthBucket: lengthBucket,
            decodeOutcome: observationStage === 'transport_error' || transportClass !== 'none' ? 'not_observed'
                : payloadKind === 'string' ? 'string_payload_ambiguous'
                : payloadKind === 'object' || payloadKind === 'array' ? 'object_payload'
                : payloadKind === 'empty' ? 'empty_payload' : 'primitive_payload',
            errorPresent: Boolean(msg.error), transportClass,
            suppressedPriorWindow: validCount(state.priorSuppressed) ? state.priorSuppressed : 0,
        };
        node.warn(JSON.stringify(event));
    }
} catch {
    // Diagnostics/storage/logger failures must not change response delivery or create retries.
}
return observationStage === 'transport_error' ? null : msg;

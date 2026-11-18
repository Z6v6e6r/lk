'use strict';

function responseType(response) {
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!mime) return 'missing';
  if (mime === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime)) return 'json';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

class MaxResponseFormatError extends Error {
  constructor(status, type, reason) {
    const diagnostic = {
      event: 'max_response_format_failed',
      code: 'MAX_RESPONSE_FORMAT_INVALID',
      upstreamStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
      responseType: type,
      reason,
      delivery: 'unknown',
      retryable: false,
    };
    super(JSON.stringify(diagnostic));
    this.name = 'MaxResponseFormatError';
    Object.assign(this, diagnostic);
  }
}

async function parseMaxJsonResponse(response) {
  // Keep valid JSON compatible even when MIME is absent or incorrect. Never retain
  // native parse errors: their message/stack can contain fragments of the body.
  try {
    return await response.json();
  } catch (error) {
    throw new MaxResponseFormatError(response.status, responseType(response),
      error instanceof SyntaxError ? 'invalid_json' : 'body_read_failed');
  }
}

module.exports = { parseMaxJsonResponse };

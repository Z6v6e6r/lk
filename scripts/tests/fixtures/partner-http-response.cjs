"use strict";
// Bounded fixture parser: refusal to parse is not a successful ingress probe.
function completeHttpResponse(bytes, method = "POST") {
  const fail = () => { throw new Error("FIXTURE_INCOMPLETE_OR_AMBIGUOUS_HTTP"); };
  if (!Buffer.isBuffer(bytes) || bytes.length > 65536) fail();
  const separator = bytes.indexOf("\r\n\r\n");
  if (separator < 0) fail();
  const lines = bytes.subarray(0, separator).toString("latin1").split("\r\n");
  const status = Number(/^HTTP\/1\.[01] ([2-5]\d{2}) [^\r\n]*$/.exec(lines.shift())?.[1]);
  if (!status) fail();
  const headers = new Map();
  for (const line of lines) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
    if (!match) fail();
    const name = match[1].toLowerCase(), value = match[2].trim();
    if (headers.has(name) && ["content-length", "transfer-encoding"].includes(name)) fail();
    headers.set(name, value);
  }
  const body = bytes.subarray(separator + 4), length = headers.get("content-length"), encoding = headers.get("transfer-encoding");
  if (length !== undefined && (encoding !== undefined || !/^(0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length)))) fail();
  if (method === "HEAD" || [204, 304].includes(status)) {
    if (body.length !== 0) fail();
  } else if (length !== undefined) {
    if (body.length !== Number(length)) fail();
  } else if (encoding === "chunked") {
    let offset = 0;
    while (true) {
      const end = body.indexOf("\r\n", offset);
      if (end < 0) fail();
      const raw = body.subarray(offset, end).toString("latin1");
      // Extensions/trailers are not produced by this fixture; reject rather than guess.
      if (!/^[0-9a-fA-F]{1,8}$/.test(raw)) fail();
      const size = Number.parseInt(raw, 16); offset = end + 2;
      if (size === 0) {
        if (body.subarray(offset).toString("latin1") !== "\r\n") fail();
        break;
      }
      if (offset + size + 2 > body.length || body.subarray(offset + size, offset + size + 2).toString("latin1") !== "\r\n") fail();
      offset += size + 2;
    }
  } else fail(); // No close-delimited success: cannot distinguish truncation.
  return { status, noStore: headers.get("cache-control") === "no-store", cors: [...headers.keys()].some(name => name.startsWith("access-control-")) };
}
module.exports = { completeHttpResponse };

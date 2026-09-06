"use strict";

// Fixture transport parser: an interim 100 is not the final response. Never
// classify a bare reset or incomplete length-framed response as an HTTP refusal.
const withoutContinue = (output) => output.replace(/^(?:HTTP\/1\.[01] 100 Continue\r\n\r\n)+/i, "");
function completeResponseBeforeReset(output) {
  const final = withoutContinue(output);
  const end = final.indexOf("\r\n\r\n");
  if (end < 0 || !/^HTTP\/1\.[01] [2-5][0-9]{2} /.test(final)) return false;
  const headers = final.slice(0, end);
  const lengths = [...headers.matchAll(/^content-length: (0|[1-9][0-9]*)\r?$/gim)];
  if (lengths.length !== 1 || /^transfer-encoding:/im.test(headers)) return false;
  const length = Number(lengths[0][1]);
  return Number.isSafeInteger(length) && Buffer.byteLength(final.slice(end + 4)) === length;
}
module.exports = { withoutContinue, completeResponseBeforeReset };

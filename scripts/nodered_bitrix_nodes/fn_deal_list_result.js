const status = Number(msg.statusCode);
const upstreamStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
const result = msg.payload?.result;
const reason = msg.error ? "transport_error"
  : upstreamStatus === null || upstreamStatus < 200 || upstreamStatus >= 300 ? "upstream_status"
    : msg.payload?.error ? "provider_error"
      : !Array.isArray(result) ? "result_shape"
        : result.some(row => !row || typeof row !== "object" || Array.isArray(row)) ? "record_shape" : null;
if (reason) {
  // Never treat a failed lookup as a valid empty report, or log provider bodies/URLs.
  if (typeof node !== "undefined" && typeof node.warn === "function") {
    node.warn(JSON.stringify({ event: "bitrix_deal_list_failed",
      code: "BITRIX_DEAL_LIST_RESPONSE_INVALID", reason, upstreamStatus }));
  }
  return null;
}
msg.payload = result.map(row => row.ID);
return msg;

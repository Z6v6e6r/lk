const requestPath = String(
  msg?._requestUrl
  || msg?.req?.originalUrl
  || msg?.req?.url
  || msg?.req?.route?.path
  || "",
);
const isSession = requestPath.includes("/result/session/")
  || Boolean(msg._resultSessionOpen)
  || Boolean(msg._resultSessionPatch);
const rawError = msg.error && typeof msg.error === "object"
  ? msg.error
  : null;

msg._resultWriteDiagnostic = {
  message: rawError?.message || (typeof msg.error === "string" ? msg.error : "Node-RED result write failed"),
  source: rawError?.source || null,
};
msg.statusCode = 503;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  error: isSession
    ? "Result draft was not saved. Retry after refreshing the session."
    : "Result was not saved. Retry with the same submission id.",
  code: isSession ? "RESULT_SESSION_PERSISTENCE_FAILED" : "RESULT_PERSISTENCE_FAILED",
  retryable: true,
};

return [msg, msg];

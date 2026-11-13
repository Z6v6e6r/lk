// A Catch message can contain the Bearer, integration token, original body and
// arbitrary upstream error details. Only the HTTP envelope may leave this node.
if (msg.req?.headers && typeof msg.req.headers === "object") {
  for (const key of Object.keys(msg.req.headers)) {
    if (["authorization", "x-cup-integration-token"].includes(key.toLowerCase())) {
      delete msg.req.headers[key];
    }
  }
}
if (Array.isArray(msg.req?.rawHeaders)) {
  const headers = [];
  for (let index = 0; index < msg.req.rawHeaders.length; index += 2) {
    const name = String(msg.req.rawHeaders[index]).toLowerCase();
    if (!["authorization", "x-cup-integration-token"].includes(name)) {
      headers.push(msg.req.rawHeaders[index], msg.req.rawHeaders[index + 1]);
    }
  }
  msg.req.rawHeaders = headers;
}
return {
  _msgid: msg._msgid,
  req: msg.req,
  res: msg.res,
  statusCode: 503,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  },
  payload: {
    code: "RESULT_AUTH_SERVICE_UNAVAILABLE",
    error: "Не удалось проверить профиль участника",
  },
};

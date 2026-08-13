msg.statusCode = 503;
msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
msg.payload = { ok: false, code: "PERSISTENCE_UNAVAILABLE", message: "Removal state is temporarily unavailable" };
delete msg._staffLeaveCtx;
delete msg._staffLeaveStatusCtx;
return msg;

msg.statusCode = 503;
msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
msg.payload = { error: 'COMMUNITY_REPORT_UNAVAILABLE', retryable: true };
delete msg.error;
return msg;

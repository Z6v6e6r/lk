msg.statusCode = 204;
msg.headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Correlation-ID', 'Access-Control-Max-Age': '600', 'Allow': 'POST, OPTIONS', 'Cache-Control': 'no-store' };
msg.payload = '';
return msg;

delete msg._fprStart;
delete msg.error;
delete msg.headers;
msg.statusCode = 503;
msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
msg.payload = { error: 'FPR_CANONICAL_START_UNAVAILABLE', message: 'Не удалось загрузить стартовые уровни ЦУП. Повторите загрузку.' };
return msg;

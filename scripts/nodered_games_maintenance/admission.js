// Installed CLOSED. No user-supplied field or elapsed lease may reopen this gate.
if (!msg.req || !msg.res) return null;
msg.statusCode = 503;
msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '120' };
msg.payload = { ok: false, code: 'GAMES_MAINTENANCE', message: 'Обновляем игры. Повторите действие позже.' };
return msg;

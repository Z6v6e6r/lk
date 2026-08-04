const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

const context = isObj(msg._tournamentBroadcast) ? msg._tournamentBroadcast : null;
if (!context) {
  msg.payload = {
    ok: false,
    target: null,
    label: null,
    statusCode: 0,
    message: "Контекст команды трансляции потерян",
  };
  return msg;
}

const upstreamStatus = Number(msg.statusCode) || 0;
const upstreamMessage = isObj(msg.payload)
  ? String(msg.payload.message || msg.payload.error || msg.payload.detail || "").trim()
  : String(msg.error?.message || msg.payload || "").trim();
const commandAction = context.commandAction === "stop" ? "stop" : "start";
const alreadyStopped = commandAction === "stop"
  && upstreamStatus === 409
  && /no active tournament session/i.test(upstreamMessage);
const alreadyStarted = commandAction === "start"
  && upstreamStatus === 409
  && /same state/i.test(upstreamMessage);
const ok = (upstreamStatus >= 200 && upstreamStatus < 300) || alreadyStopped || alreadyStarted;
const safeFailureMessage = commandAction === "stop"
  ? "Приставка не подтвердила остановку трансляции"
  : "Приставка не подтвердила запуск трансляции";

msg.payload = {
  ok,
  target: context.targetKey || null,
  label: context.targetLabel || null,
  statusCode: upstreamStatus,
  message: ok ? null : safeFailureMessage,
};
delete msg.statusCode;
delete msg.error;
return msg;

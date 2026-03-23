const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

const payload = isObj(msg.payload) ? msg.payload : {};
const commands = Array.isArray(payload.commands) ? payload.commands : [];
msg.payload = commands;
return commands.length > 0 ? [msg, null] : [null, msg];

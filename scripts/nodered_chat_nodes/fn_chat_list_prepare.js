const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};

const q = msg.req?.query || {};
const phone = normPhone(q.phone || q.phoneNumber || q.userPhone || q.mobile);
if (!phone) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "phone is required" };
  return [null, msg, msg];
}

msg._chatList = { phone };
msg.payload = { relatedPhones: phone, deleted: { $ne: true } };
return [msg, null, msg];

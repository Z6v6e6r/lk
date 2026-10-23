msg.statusCode = 503;
msg.headers = {"Content-Type":"application/json; charset=utf-8"};
msg.payload = {error:"Хранилище временно недоступно",details:{code:"PITER_ATOMIC_MONGO_ERROR"}};
if (msg._summerSubscriptionCtx?.reconcile === true) {
  if (typeof node !== "undefined" && typeof node.warn === "function") {
    node.warn(JSON.stringify({ event: "subscription_atomic_background_failed",
      code: "PITER_ATOMIC_MONGO_ERROR", statusCode: 503 }));
  }
  return [null,msg];
}
return [msg,msg];

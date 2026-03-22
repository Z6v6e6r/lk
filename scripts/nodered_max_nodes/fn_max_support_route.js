const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));

function getApiBase() {
  try {
    return toStr(env.get("SUPPORT_API_BASE_URL")) || "http://127.0.0.1:1880";
  } catch {
    return "http://127.0.0.1:1880";
  }
}

function buildMessage(chatId, content, options = null) {
  return {
    payload: {
      chatId,
      type: "message",
      content,
      options: options || undefined,
    },
  };
}

function buildContactOptions() {
  return {
    reply_markup: JSON.stringify({
      keyboard: [[{ text: "Поделиться номером", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: false,
    }),
  };
}

function buildStationOptions() {
  return {
    reply_markup: JSON.stringify({
      keyboard: [
        [{ text: "Нагатинская" }],
        [{ text: "Нагатинская Премиум" }],
        [{ text: "Терехово" }],
        [{ text: "Сколково" }],
        [{ text: "Ясенево" }],
        [{ text: "Селигерская" }],
        [{ text: "Сочи" }],
        [{ text: "Точка сбора" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    }),
  };
}

const update = isObj(msg.maxUpdate) ? msg.maxUpdate : null;
if (!update) {
  return [null, null, msg];
}

const clientPayload = isObj(msg.payload) ? msg.payload : {};
const client = isObj(clientPayload.client) ? clientPayload.client : null;
const chatId = toStr(update.recipient?.chatId);
const senderUserId = toStr(update.sender?.userId);
const senderName = toStr(update.sender?.name) || "Клиент";
const authStatus = toStr(client?.authStatus) || (update.contact?.phone ? "AUTHORIZED" : "PENDING_CONTACT");
const workflowState = toStr(client?.workflowState)
  || (authStatus !== "AUTHORIZED" ? "WAIT_CONTACT" : (toStr(client?.lastStationId) ? "READY" : "WAIT_STATION"));
const stationId = update.station?.id || toStr(client?.lastStationId) || "UNASSIGNED";
const stationName = update.station?.name || toStr(client?.lastStationName) || "Без станции";

const supportEvent = {
  channel: "MAX",
  direction: "INBOUND",
  authorType: "CLIENT",
  eventType: "MESSAGE",
  text: update.text,
  displayName: senderName,
  phone: update.contact?.phone || null,
  phoneNumbers: update.contact?.phone ? [update.contact.phone] : [],
  authStatus,
  workflowState,
  stationId,
  stationName,
  channelUserId: senderUserId,
  userId: senderUserId,
  chatId,
  externalMessageId: update.messageId || null,
  externalThreadId: chatId,
  senderName,
  senderId: senderUserId,
  attachments: update.attachments || [],
  metadata: {
    provider: "max",
    messageKind: update.messageKind,
    command: update.command || null,
    stationToken: update.station?.id || null,
  },
};

const outboundMessages = [];

if (update.command === "/start") {
  supportEvent.eventType = "START";
  if (authStatus !== "AUTHORIZED") {
    supportEvent.authStatus = "PENDING_CONTACT";
    supportEvent.workflowState = "WAIT_CONTACT";
    outboundMessages.push(buildMessage(
      chatId,
      "Чтобы подключить администратора, нужно подтвердить номер телефона. Нажмите кнопку ниже.",
      buildContactOptions(),
    ));
  } else if (workflowState === "WAIT_STATION") {
    outboundMessages.push(buildMessage(
      chatId,
      "Номер подтверждён. Теперь выберите станцию, чтобы мы направили диалог нужной команде.",
      buildStationOptions(),
    ));
  } else {
    outboundMessages.push(buildMessage(
      chatId,
      "Вы уже авторизованы. Напишите сообщение, и мы подключим администратора по вашей станции.",
    ));
  }
} else if (update.messageKind === "contact" && update.contact?.phone) {
  supportEvent.eventType = "CONTACT_SHARED";
  supportEvent.phone = update.contact.phone;
  supportEvent.phoneNumbers = [update.contact.phone];
  supportEvent.authStatus = "AUTHORIZED";
  supportEvent.workflowState = stationId && stationId !== "UNASSIGNED" ? "READY" : "WAIT_STATION";
  supportEvent.text = "Клиент поделился контактом";
  outboundMessages.push(buildMessage(
    chatId,
    "Спасибо. Номер сохранён. Теперь выберите станцию, чтобы мы направили обращение нужному администратору.",
    buildStationOptions(),
  ));
} else if (update.messageKind === "station" && update.station) {
  supportEvent.eventType = "STATION_SELECTED";
  supportEvent.stationId = update.station.id;
  supportEvent.stationName = update.station.name;
  supportEvent.text = `Выбрана станция: ${update.station.name}`;
  supportEvent.workflowState = authStatus === "AUTHORIZED" ? "READY" : "WAIT_CONTACT";
  if (authStatus !== "AUTHORIZED") {
    outboundMessages.push(buildMessage(
      chatId,
      "Подключить администратора мы можем только для авторизованных пользователей. Сначала поделитесь номером телефона.",
      buildContactOptions(),
    ));
  } else {
    outboundMessages.push(buildMessage(
      chatId,
      `Станция ${update.station.name} сохранена. Теперь можете написать сообщение для администратора.`,
    ));
  }
} else {
  supportEvent.eventType = "MESSAGE";
  if (authStatus !== "AUTHORIZED") {
    supportEvent.workflowState = "WAIT_CONTACT";
    outboundMessages.push(buildMessage(
      chatId,
      "Подключить администратора мы можем только для авторизованных пользователей. Поделитесь номером телефона, и мы продолжим диалог.",
      buildContactOptions(),
    ));
  } else if (workflowState === "WAIT_STATION") {
    outboundMessages.push(buildMessage(
      chatId,
      "Номер подтверждён, но станция ещё не выбрана. Пожалуйста, выберите станцию.",
      buildStationOptions(),
    ));
  }
}

const supportEventMsg = Object.assign({}, msg, {
  method: "POST",
  url: `${getApiBase()}/lk/support/dialogs/events`,
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  payload: supportEvent,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    maxUpdate: update,
    supportEvent,
    outboundCount: outboundMessages.length,
    clientFound: Boolean(client),
  },
});

return [supportEventMsg, outboundMessages, debugMsg];

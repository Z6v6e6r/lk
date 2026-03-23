const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

function getApiBase() {
  try {
    return toStr(env.get("SUPPORT_API_BASE_URL")) || "http://127.0.0.1:3000/api";
  } catch {
    return "http://127.0.0.1:3000/api";
  }
}

function getIntegrationToken() {
  try {
    return toStr(env.get("SUPPORT_INTEGRATION_TOKEN"));
  } catch {
    return null;
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

const lookupPayload = isObj(msg.payload) ? msg.payload : {};
const client = isObj(lookupPayload.client) ? lookupPayload.client : null;
const chatId = toStr(update.recipient?.chatId);
const senderUserId = toStr(update.sender?.userId);
const senderName = toStr(update.sender?.name) || "Клиент";
const authVerified = Boolean(client && client.authStatus === "VERIFIED") || Boolean(update.contact?.phone);
const currentStationId = toStr(client?.currentStationId) || null;
const currentStationName = toStr(client?.currentStationName) || null;
const selectedStationId = update.station?.id || null;
const selectedStationName = update.station?.name || null;

const event = {
  connector: "MAX_BOT",
  externalUserId: senderUserId,
  externalChatId: chatId,
  externalMessageId: update.messageId || null,
  displayName: senderName,
  username: update.sender?.username || null,
  phone: update.contact?.phone || null,
  text: update.text || null,
  direction: "INBOUND",
  stationId: currentStationId,
  stationName: currentStationName,
  selectedStationId: selectedStationId,
  selectedStationName: selectedStationName,
  subject: senderName,
  kind: update.messageKind === "contact"
    ? "CONTACT"
    : update.messageKind === "station"
      ? "STATION_SELECTION"
      : update.messageKind === "command"
        ? "COMMAND"
        : "TEXT",
  meta: {
    provider: "max",
    command: update.command || null,
    rawMessageKind: update.messageKind,
  },
};

const outbound = [];

if (update.command === "/start") {
  if (!authVerified) {
    outbound.push(buildMessage(
      chatId,
      "Чтобы подключить администратора, сначала подтвердите номер телефона. Нажмите кнопку ниже.",
      buildContactOptions(),
    ));
  } else if (!currentStationId) {
    outbound.push(buildMessage(
      chatId,
      "Номер уже подтвержден. Теперь выберите станцию, чтобы мы направили обращение нужной команде.",
      buildStationOptions(),
    ));
  } else {
    outbound.push(buildMessage(
      chatId,
      `Вы уже подключены к станции ${currentStationName || currentStationId}. Напишите сообщение, и мы подключим администратора.`,
    ));
  }
} else if (update.messageKind === "contact" && update.contact?.phone) {
  outbound.push(buildMessage(
    chatId,
    "Спасибо. Номер сохранен. Теперь выберите станцию, чтобы мы направили обращение нужному администратору.",
    buildStationOptions(),
  ));
} else if (update.messageKind === "station" && update.station) {
  if (!authVerified) {
    outbound.push(buildMessage(
      chatId,
      "Подключить администратора мы можем только для авторизованных пользователей. Сначала поделитесь номером телефона.",
      buildContactOptions(),
    ));
  } else {
    outbound.push(buildMessage(
      chatId,
      `Станция ${update.station.name} сохранена. Теперь можете написать сообщение для администратора.`,
    ));
  }
} else if (!authVerified) {
  outbound.push(buildMessage(
    chatId,
    "Подключить администратора мы можем только для авторизованных пользователей. Поделитесь номером телефона, и мы продолжим диалог.",
    buildContactOptions(),
  ));
} else if (!currentStationId && !selectedStationId) {
  outbound.push(buildMessage(
    chatId,
    "Номер подтвержден, но станция еще не выбрана. Пожалуйста, выберите станцию.",
    buildStationOptions(),
  ));
}

const integrationToken = getIntegrationToken();
const supportEventMsg = Object.assign({}, msg, {
  method: "POST",
  url: `${getApiBase()}/support/dialogs/events`,
  headers: Object.assign(
    { "Content-Type": "application/json", Accept: "application/json" },
    integrationToken ? { "x-integration-token": integrationToken } : {},
  ),
  payload: event,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    maxUpdate: update,
    client,
    supportEvent: event,
    outboundCount: outbound.length,
  },
});

return [supportEventMsg, outbound, debugMsg];

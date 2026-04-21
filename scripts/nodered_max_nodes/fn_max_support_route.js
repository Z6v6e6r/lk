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

function buildInlineKeyboard(buttons) {
  return {
    type: "inline_keyboard",
    payload: {
      buttons,
    },
  };
}

function buildMessage(chatId, text, attachments = null, format = null) {
  const normalizedText = toStr(text);
  if (!chatId || !normalizedText) {
    return null;
  }

  let payload = normalizedText;
  if (format || (Array.isArray(attachments) && attachments.length)) {
    payload = {
      text: normalizedText,
    };
    if (format) {
      payload.format = format;
    }
    if (Array.isArray(attachments) && attachments.length) {
      payload.attachments = attachments;
    }
  }

  return {
    chatId,
    payload,
  };
}

function buildContactRequestAttachment() {
  return [
    buildInlineKeyboard([
      [
        {
          type: "request_contact",
          text: "Поделиться номером",
          payload: "share_contact",
        },
      ],
    ]),
  ];
}

function buildStationAttachment() {
  return [
    buildInlineKeyboard([
      [{ type: "callback", text: "Нагатинская", payload: "nagat" }],
      [{ type: "callback", text: "Нагатинская Премиум", payload: "nagat_p" }],
      [{ type: "callback", text: "Терехово", payload: "tereh" }],
      [{ type: "callback", text: "Сколково", payload: "kuncev" }],
      [{ type: "callback", text: "Ясенево", payload: "yas" }],
      [{ type: "callback", text: "Селигерская", payload: "seleger" }],
      [{ type: "callback", text: "Сочи", payload: "sochi" }],
      [{ type: "callback", text: "Точка сбора", payload: "t-sbora" }],
    ]),
  ];
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
      buildContactRequestAttachment(),
    ));
  } else if (!currentStationId) {
    outbound.push(buildMessage(
      chatId,
      "Номер уже подтвержден. Теперь выберите станцию, чтобы мы направили обращение нужной команде.",
      buildStationAttachment(),
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
    buildStationAttachment(),
  ));
} else if (update.messageKind === "station" && update.station) {
  if (!authVerified) {
    outbound.push(buildMessage(
      chatId,
      "Подключить администратора мы можем только для авторизованных пользователей. Сначала поделитесь номером телефона.",
      buildContactRequestAttachment(),
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
    buildContactRequestAttachment(),
  ));
} else if (!currentStationId && !selectedStationId) {
  outbound.push(buildMessage(
    chatId,
    "Номер подтвержден, но станция еще не выбрана. Пожалуйста, выберите станцию.",
    buildStationAttachment(),
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

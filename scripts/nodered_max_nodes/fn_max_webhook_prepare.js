const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const toInt = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));

function extractPhoneFromVcard(vcf) {
  const source = toStr(vcf);
  if (!source) return null;

  const telLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^TEL(?:;[^:]*)?:/i.test(line));

  if (!telLine) {
    return null;
  }

  const [, phonePart] = telLine.split(/:(.+)/, 2);
  return normPhone(phonePart);
}

function buildSenderName(sender) {
  const firstName = toStr(sender?.first_name || sender?.firstName);
  const lastName = toStr(sender?.last_name || sender?.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || toStr(sender?.name) || toStr(sender?.username) || null;
}

function makeHttpResponse(baseMsg, statusCode, payload) {
  return Object.assign({}, baseMsg, {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload,
  });
}

function extractContact(rawMessage, body, attachments) {
  const contactAttachment = attachments.find((item) => String(item?.type || "").toLowerCase() === "contact") || null;
  const attachmentPayload = isObj(contactAttachment?.payload) ? contactAttachment.payload : null;
  const attachmentMaxInfo = isObj(attachmentPayload?.max_info) ? attachmentPayload.max_info : null;
  const directContact =
    (isObj(body.contact) ? body.contact : null)
    || (isObj(rawMessage.contact) ? rawMessage.contact : null)
    || attachments.find((item) => isObj(item.contact))?.contact
    || attachmentPayload
    || contactAttachment
    || null;

  if (!isObj(directContact)) {
    return null;
  }

  const phone =
    normPhone(
      directContact.phone_number
      || directContact.phone
      || directContact.phoneNumber
      || directContact.msisdn
      || attachmentPayload?.phone_number
      || attachmentPayload?.phone
      || attachmentPayload?.phoneNumber
      || attachmentPayload?.msisdn,
    );

  const phoneFromVcard = phone || extractPhoneFromVcard(attachmentPayload?.vcf_info || directContact.vcf_info);
  if (!phoneFromVcard) return null;

  return {
    phone: phoneFromVcard,
    firstName: toStr(
      directContact.first_name
      || directContact.firstName
      || attachmentMaxInfo?.first_name
      || attachmentMaxInfo?.firstName,
    ),
    lastName: toStr(
      directContact.last_name
      || directContact.lastName
      || attachmentMaxInfo?.last_name
      || attachmentMaxInfo?.lastName,
    ),
    userId: toStr(
      directContact.user_id
      || directContact.userId
      || attachmentMaxInfo?.user_id
      || attachmentMaxInfo?.userId,
    ),
    raw: {
      contact: directContact,
      attachment: contactAttachment,
      payload: attachmentPayload,
    },
  };
}

function extractButtonValue(rawMessage, body) {
  return (
    toStr(body.callback_data)
    || toStr(body.callbackData)
    || toStr(body.button)
    || toStr(rawMessage.callback_data)
    || toStr(rawMessage.callbackData)
    || null
  );
}

const stationMap = new Map([
  ["нaгатинская", { id: "nagat", name: "Нагатинская" }],
  ["нагатинская", { id: "nagat", name: "Нагатинская" }],
  ["нагатинская премиум", { id: "nagat_p", name: "Нагатинская Премиум" }],
  ["терехово", { id: "tereh", name: "Терехово" }],
  ["сколково", { id: "kuncev", name: "Сколково" }],
  ["ясенево", { id: "yas", name: "Ясенево" }],
  ["селигерская", { id: "seleger", name: "Селигерская" }],
  ["питер", { id: "piter", name: "Питер" }],
  ["сочи", { id: "sochi", name: "Сочи" }],
  ["котельники", { id: "kotelniki", name: "Котельники" }],
  ["щербинка", { id: "shcherbinka", name: "Щербинка" }],
  ["люберцы", { id: "lyubertsy", name: "Люберцы" }],
  ["коломна", { id: "kolomna", name: "Коломна" }],
  ["точка сбора", { id: "t-sbora", name: "Точка сбора" }],
  ["nagat", { id: "nagat", name: "Нагатинская" }],
  ["nagat_p", { id: "nagat_p", name: "Нагатинская Премиум" }],
  ["tereh", { id: "tereh", name: "Терехово" }],
  ["kuncev", { id: "kuncev", name: "Сколково" }],
  ["yas", { id: "yas", name: "Ясенево" }],
  ["seleger", { id: "seleger", name: "Селигерская" }],
  ["piter", { id: "piter", name: "Питер" }],
  ["sochi", { id: "sochi", name: "Сочи" }],
  ["kotelniki", { id: "kotelniki", name: "Котельники" }],
  ["shcherbinka", { id: "shcherbinka", name: "Щербинка" }],
  ["lyubertsy", { id: "lyubertsy", name: "Люберцы" }],
  ["kolomna", { id: "kolomna", name: "Коломна" }],
  ["t-sbora", { id: "t-sbora", name: "Точка сбора" }],
]);

function extractStation(text, buttonValue) {
  const candidates = [
    toStr(buttonValue)?.toLowerCase(),
    toStr(text)?.toLowerCase(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (stationMap.has(candidate)) {
      return stationMap.get(candidate);
    }
  }
  return null;
}

const expectedSecret = (() => {
  try {
    return toStr(env.get("MAX_BOT_WEBHOOK_SECRET"));
  } catch {
    return null;
  }
})();

const rawPayload = isObj(msg.maxUpdate)
  ? msg.maxUpdate
  : (isObj(msg.payload) ? msg.payload : null);

if (!rawPayload) {
  const response = makeHttpResponse(msg, 400, {
    ok: false,
    provider: "max",
    error: "JSON body is required",
  });
  return [null, response, response];
}

const isWebhook = Boolean(msg.req);
if (isWebhook) {
  const incomingSecret = toStr(msg.req?.headers?.["x-max-bot-api-secret"]);
  if (expectedSecret && incomingSecret !== expectedSecret) {
    const response = makeHttpResponse(msg, 401, {
      ok: false,
      provider: "max",
      error: "Invalid X-Max-Bot-Api-Secret header",
    });
    return [null, response, response];
  }
}

const transportData = isObj(rawPayload.data) ? rawPayload.data : null;
const rawMessage =
  (isObj(rawPayload.message) ? rawPayload.message : null)
  || (isObj(rawPayload.originalMessage) ? rawPayload.originalMessage : null)
  || transportData
  || rawPayload;
const sender = isObj(rawMessage.sender)
  ? rawMessage.sender
  : (isObj(rawMessage.from) ? rawMessage.from : (isObj(transportData?.sender) ? transportData.sender : {}));
const recipient = isObj(rawMessage.recipient)
  ? rawMessage.recipient
  : (isObj(transportData?.recipient) ? transportData.recipient : {});
const body = isObj(rawMessage.body)
  ? rawMessage.body
  : (isObj(transportData?.body) ? transportData.body : (isObj(rawPayload.body) ? rawPayload.body : rawMessage));
const attachments = uniq([
  ...toArray(body.attachments),
  ...toArray(rawMessage.attachments),
  ...toArray(transportData?.attachments),
]).filter((item) => item !== null && item !== undefined);

const text =
  toStr(body.text)
  || toStr(rawMessage.text)
  || toStr(transportData?.text)
  || toStr(rawPayload.text)
  || toStr(rawPayload.content)
  || null;
const buttonValue = extractButtonValue(rawMessage, body);
const command = text && text.startsWith("/") ? text.split(/\s+/)[0] : null;
const contact = extractContact(rawMessage, body, attachments);
const station = extractStation(text, buttonValue);
const updateType = toStr(rawPayload.update_type || rawPayload.type || rawMessage.type || transportData?.type) || "message";
const updateTimestamp = toInt(rawPayload.timestamp || rawMessage.timestamp || transportData?.timestamp) ?? Date.now();

const normalized = {
  provider: "max",
  updateType,
  timestamp: updateTimestamp,
  messageId: toStr(rawMessage.mid || rawMessage.message_id || body.mid || body.message_id || rawPayload.messageId),
  messageTimestamp: toInt(rawMessage.timestamp || body.timestamp) ?? updateTimestamp,
  text,
  command,
  buttonValue,
  contact,
  station,
  messageKind: contact
    ? "contact"
    : station
      ? "station"
      : command
        ? "command"
        : (text ? "text" : "unknown"),
  attachments,
  sender: {
    userId: toStr(sender.user_id || sender.userId || sender.id || rawPayload.userId),
    username: toStr(sender.username),
    name: buildSenderName(sender),
    isBot: typeof sender.is_bot === "boolean" ? sender.is_bot : null,
  },
  recipient: {
    chatId: toStr(recipient.chat_id || recipient.chatId || rawPayload.chatId || rawMessage.chatId),
    userId: toStr(recipient.user_id || recipient.userId || rawPayload.userId),
    chatType: toStr(recipient.chat_type || recipient.type || rawPayload.chatType),
  },
  raw: rawPayload,
};

const downstreamMsg = Object.assign({}, msg, {
  topic: `max/${normalized.messageKind}`,
  maxRaw: rawPayload,
  maxUpdate: normalized,
  payload: normalized,
});

const httpResponse = isWebhook
  ? makeHttpResponse(msg, 200, {
      ok: true,
      provider: "max",
      accepted: true,
      messageId: normalized.messageId,
      chatId: normalized.recipient.chatId,
      userId: normalized.sender.userId,
      messageKind: normalized.messageKind,
    })
  : null;

const debugMsg = Object.assign({}, downstreamMsg);

return [downstreamMsg, httpResponse, debugMsg];

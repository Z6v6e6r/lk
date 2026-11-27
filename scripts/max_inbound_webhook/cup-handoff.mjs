import { createHash, createHmac, randomUUID } from 'node:crypto';

export const CUP_PROOF_URL = 'https://stg-support.tsup.space/api/support/v1/public/tenants/padlhub/intake/max-proof';
export const CUP_HANDOFF_WINDOW_MS = 15 * 60_000;
const maxOrigin = 'https://platform-api2.max.ru';
const draftPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const tokenPattern = new RegExp('^cup2_(' + draftPattern + ')$');
const proofAudience = 'cup-support-staging/intake';

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function numericId(value) {
  if (typeof value === 'number') requireValue(Number.isSafeInteger(value), 'CUP_HANDOFF_ID');
  requireValue(typeof value === 'string' || typeof value === 'number', 'CUP_HANDOFF_ID');
  const text = String(value);
  requireValue(text.match(/^[1-9][0-9]{0,18}$/)?.[0] === text
    && BigInt(text) <= 9_223_372_036_854_775_807n, 'CUP_HANDOFF_ID');
  return text;
}

function messageIdentifier(value) {
  requireValue(typeof value === 'string'
    && value.match(/^[\x21-\x7e]{1,200}$/)?.[0] === value, 'CUP_HANDOFF_MESSAGE_ID');
  return value;
}

function key(parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export function cupHandoffStartKey(action) {
  return key(['MAX_BOT', 'cup2_start', action.draft, action.userId, action.chatId]);
}

export function mapCupHandoff(update, botId) {
  const start = update?.update_type === 'bot_started';
  const callback = update?.update_type === 'message_callback' ? update.callback : undefined;
  const token = start ? update.payload : callback?.payload;
  if (typeof token !== 'string' || !token.startsWith('cup2_')) return null;
  const match = token.match(tokenPattern);
  requireValue(match && match[0] === token, 'CUP_HANDOFF_PAYLOAD');

  const user = start ? update.user : callback.user;
  requireValue(user?.is_bot === false, 'CUP_HANDOFF_ACTOR');
  const action = {
    type: start ? 'start' : 'confirm',
    draft: match[1],
    userId: numericId(user.user_id),
    chatId: numericId(start ? update.chat_id : update.message?.recipient?.chat_id),
  };
  if (start) return { key: cupHandoffStartKey(action), cupHandoffAction: action };

  const message = update.message;
  requireValue(message?.recipient?.chat_type === 'dialog' && message.sender?.is_bot === true
    && numericId(message.sender.user_id) === botId, 'CUP_HANDOFF_DIALOG');
  if (message.recipient.user_id != null) {
    requireValue(numericId(message.recipient.user_id) === action.userId, 'CUP_HANDOFF_RECIPIENT');
  }
  action.promptId = messageIdentifier(message.body?.mid);
  return {
    key: key(['MAX_BOT', 'cup2_confirm', messageIdentifier(callback.callback_id)]),
    cupHandoffAction: action,
  };
}

export function cupHandoffConfig(config) {
  const settings = config.cupStagingHandoff;
  if (settings === undefined) return undefined;
  requireValue(settings && typeof settings === 'object' && !Array.isArray(settings)
    && typeof settings.enabled === 'boolean', 'CUP_HANDOFF_CONFIGURATION');
  if (!settings.enabled) return undefined;
  requireValue(settings.proofUrl === CUP_PROOF_URL && typeof config.stationBotToken === 'string'
    && numericId(config.botId) === config.botId
    && typeof settings.proofKey === 'string' && /^[A-Za-z0-9_-]{43,}$/.test(settings.proofKey)
    && ![config.webhookSecret, config.stationBotToken, config.ingressToken, config.mediaIngressToken].includes(settings.proofKey),
  'CUP_HANDOFF_CONFIGURATION');
  const proofKey = Buffer.from(settings.proofKey, 'base64url');
  requireValue(proofKey.length >= 32 && proofKey.toString('base64url') === settings.proofKey, 'CUP_HANDOFF_CONFIGURATION');
  return { botId: config.botId, botToken: config.stationBotToken, proofKey };
}

function confirmationFor(action, proofKey) {
  const confirmationKey = createHmac('sha256', proofKey)
    .update('cup-support-staging/intake/max-confirmation-key/v1').digest();
  return createHmac('sha256', confirmationKey)
    .update(['cup-support-staging/intake/max-confirmation/v1', action.draft, action.userId, action.chatId].join('\0'))
    .digest().subarray(0, 16).toString('base64url');
}

export function signCupHandoffProof(action, proofKey, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const payload = {
    iss: 'max', aud: proofAudience, sub: action.userId, chat: action.chatId,
    tenant: 'padlhub', draft: action.draft, confirmation: confirmationFor(action, proofKey),
    iat, exp: iat + 75, jti: randomUUID(),
  };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode(payload);
  const signature = createHmac('sha256', proofKey).update(signingInput).digest('base64url');
  return signingInput + '.' + signature;
}

export function createCupHandoffService(settings, request, fetchProof = fetch) {
  const maxHeaders = { authorization: settings.botToken, 'content-type': 'application/json' };
  const confirmation = action => confirmationFor(action, settings.proofKey);
  const confirmationDigest = action => key([confirmation(action)]);
  let verifiedBot = false;
  async function sendMessage({ chatId, userId }, message) {
    const url = new URL('/messages', maxOrigin);
    url.searchParams.set('chat_id', chatId);
    const response = await request(url, { method: 'POST', headers: maxHeaders, body: JSON.stringify(message) });
    const returned = response?.message;
    requireValue(returned?.recipient?.chat_type === 'dialog' && numericId(returned.recipient.chat_id) === chatId
      && (returned.recipient.user_id == null || numericId(returned.recipient.user_id) === userId)
      && returned.sender?.is_bot === true && numericId(returned.sender.user_id) === settings.botId, 'CUP_HANDOFF_MESSAGE_RECEIPT');
    return messageIdentifier(returned.body?.mid);
  }
  return {
    confirmationDigest,
    sendMessage,
    async verifiedDialog({ chatId, userId }) {
      if (!verifiedBot) {
        const bot = await request(new URL('/me', maxOrigin), { headers: maxHeaders });
        requireValue(bot?.is_bot === true && numericId(bot.user_id) === settings.botId, 'CUP_HANDOFF_BOT');
        verifiedBot = true;
      }
      const chat = await request(new URL('/chats/' + chatId, maxOrigin), { headers: maxHeaders });
      return chat?.type === 'dialog' && chat.status === 'active' && numericId(chat.chat_id) === chatId
        && chat.dialog_with_user?.is_bot === false && numericId(chat.dialog_with_user.user_id) === userId;
    },
    prompt(action) {
      return sendMessage(action, {
        text: 'Подтвердите контакт для обращения в поддержку CUP. Нажимайте кнопку, только если вы заполнили форму.',
        attachments: [{ type: 'inline_keyboard', payload: { buttons: [
          [{ type: 'callback', text: 'Подтвердить обращение', payload: 'cup2_' + action.draft }],
        ] } }],
      });
    },
    deliverReturn(action) {
      const code = confirmation(action);
      const url = new URL('/intake', CUP_PROOF_URL);
      url.searchParams.set('from', 'max');
      url.hash = new URLSearchParams({ maxDraft: action.draft, maxProof: code }).toString();
      return sendMessage(action, {
        text: 'Контакт подтверждён. Вернитесь в CUP, чтобы отправить обращение. Если открылся другой браузер, скопируйте код и вставьте его в исходную форму.\n\n' + code,
        attachments: [{ type: 'inline_keyboard', payload: { buttons: [
          [{ type: 'link', text: 'Вернуться в CUP', url: url.href }],
          [{ type: 'clipboard', text: 'Скопировать код', payload: code }],
        ] } }],
      });
    },
    async deliverProof(action) {
      const proof = signCupHandoffProof(action, settings.proofKey);
      const response = await fetchProof(CUP_PROOF_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proof }),
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
      // The proof response carries no data required by the receiver.
      await response.body?.cancel();
      if (response.status === 204) return { status: 'accepted', confirmationDigest: confirmationDigest(action) };
      if (response.status === 409) return { status: 'conflict' };
      if (response.status === 408 || response.status === 429 || response.status >= 500) return { status: 'retry' };
      return { status: 'refused' };
    },
  };
}

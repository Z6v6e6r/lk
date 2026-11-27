const endpoint = 'https://cup-replies-private.tsup.space:19445/api/support/v1/internal/max-replies/';
const messageId = /^[A-Za-z0-9_.-]{1,200}$/;
const accountId = /^[1-9][0-9]{0,18}$/;
const validAccount = value => typeof value === 'string' && accountId.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
const validMessageId = value => typeof value === 'string' && messageId.test(value);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const outcomes = new Set(['stored', 'unmatched', 'stale', 'choose', 'closed', 'no_open', 'retry', 'refused', 'unknown_reply']);
const hints = {
  choose: 'У вас несколько открытых обращений. Нажмите «Ответить» на сообщении поддержки по нужному тикету.',
  unknown_reply: 'Не удалось определить обращение. Нажмите «Ответить» на сообщении поддержки с номером тикета.',
  closed: 'Это обращение закрыто. Если вопрос остался, создайте новое: https://stg-support.tsup.space/intake',
  no_open: 'У вас нет открытых обращений. Создать обращение: https://stg-support.tsup.space/intake',
  retry: 'Список обращений изменился. Ответьте на сообщении поддержки по нужному тикету.',
  refused: 'Переписка по этому обращению недоступна. Откройте форму поддержки: https://stg-support.tsup.space/intake',
};

export function mapCupTicketMessage(message, { user, chat, mid, timestamp, text, attachments }) {
  if (!validAccount(user) || !validAccount(chat) || !validMessageId(mid) || timestamp > 4_102_444_800_000 ||
      !text || text.startsWith('/') || text.includes('\0') || [...text].length > 4000 || attachments.length) return;
  const linked = message.link;
  if (linked != null && (linked.type !== 'reply' || !validMessageId(linked.message?.mid))) return;
  return { chat, subject: user, messageId: mid, sentAt: timestamp, body: text,
    ...(linked ? { parentId: linked.message.mid } : {}) };
}

export function cupTicketReplyKey(config, handoff) {
  const value = config.cupStagingTicketReplies;
  if (value === undefined || value?.enabled === false) return;
  const key = value?.key;
  if (value?.enabled !== true || !handoff || typeof key !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key, 'base64url').toString('base64url') !== key ||
      [config.webhookSecret, config.stationBotToken, config.ingressToken, config.mediaIngressToken,
        config.cupStagingHandoff?.proofKey].includes(key)) throw Error('CUP_TICKET_REPLY_CONFIGURATION');
  return key;
}

export function createCupTicketReplies(key, handoff, fetchCup = fetch) {
  let claimAfter = 0;

  async function call(action, body) {
    const response = await fetchCup(new URL(action, endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cup-max-reply-key': key },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    if (response.status === 204 && action !== 'receive') return;
    if (response.status !== 200 || action === 'finish' || !response.body) {
      await response.body?.cancel();
      throw Error('CUP_TICKET_REPLY_UPSTREAM');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32_768) throw Error('CUP_TICKET_REPLY_RESPONSE_LIMIT');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function finish(result) {
    try { await call('finish', result); }
    catch { await call('finish', result); }
  }

  return {
    async receive(message) {
      const result = await call('receive', message);
      if (!outcomes.has(result?.outcome)) throw Error('CUP_TICKET_REPLY_OUTCOME');
      return result.outcome;
    },
    hasHint: outcome => Object.hasOwn(hints, outcome),
    async hint({ chat, subject }, outcome, stopped) {
      const dialogue = { chatId: chat, userId: subject };
      if (!await handoff.verifiedDialog(dialogue) || stopped()) return;
      await handoff.sendMessage(dialogue, { text: hints[outcome] });
    },
    async flush(stopped) {
      if (stopped() || claimAfter > Date.now()) return;
      try {
        const claim = await call('claim', {});
        if (!claim) return;
        const { id, lease, chat, subject, number, body } = claim;
        if (!uuid.test(id) || !uuid.test(lease) || !validAccount(chat) || !validAccount(subject) ||
            !/^PDH-[1-9][0-9]*$/.test(number) || typeof body !== 'string' || !body.trim() || [...body].length > 4000) {
          throw Error('CUP_TICKET_REPLY_CLAIM');
        }
        const dialogue = { chatId: chat, userId: subject };
        let verified;
        try { verified = await handoff.verifiedDialog(dialogue); } catch { /* Retry the read-only dialogue check. */ }
        if (verified === undefined || stopped()) {
          await finish({ id, lease, outcome: 'retry', delaySeconds: 30 });
          return;
        }
        if (!verified) {
          await finish({ id, lease, outcome: 'failed' });
          return;
        }
        const head = `${number}\n\n`;
        const text = [...head, ...body].length <= 4000 ? head + body : body;
        let providerId;
        try {
          const mid = await handoff.sendMessage(dialogue, { text });
          if (validMessageId(mid)) providerId = mid;
        } catch { /* Delivery may already have happened. */ }
        await finish(providerId
          ? { id, lease, outcome: 'delivered', providerId }
          : { id, lease, outcome: 'ambiguous' });
      } catch {
        claimAfter = Date.now() + 10_000;
        console.warn('CUP_TICKET_REPLY_OUTBOX_UNCONFIRMED');
      }
    },
  };
}

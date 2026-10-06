// Embedded verbatim into the standalone Node-RED Function by build_flow.mjs.
// Dependencies are injected so tests never need MongoDB or Telegram access.
export function createCampaignEngine({ db, crypto, https, token, sendEnabled = false,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date(), transport }) {
  const campaignIds = ['academy', 'friendship', 'group', 'return'];
  const states = ['pending', 'sending', 'accepted', 'blocked', 'unreachable', 'failed', 'retry_wait', 'unknown', 'suppressed_blocked'];
  let closed = false;
  const fail = code => { throw new Error(code); };
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ack = result => { if (!result?.acknowledged) fail('mongo_ack_missing'); return result; };
  const changed = result => { if (ack(result).matchedCount !== 1) fail('mongo_cas_failed'); };
  const id = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));

  function validate(manifest, config, requireMessages = false) {
    if (manifest?.schemaVersion !== 1 || config?.schemaVersion !== 1 ||
      !/^reactivation-[0-9]{8}-[a-z0-9-]{1,32}$/.test(manifest.batchId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(manifest.audienceSnapshotDate) || !id(config.botId)) fail('invalid_manifest_or_bot_id');
    if (manifest.campaigns?.length !== 4 || config.campaigns?.length !== 4) fail('four_campaigns_required');
    const seen = new Set();
    const recipients = [];
    const messages = [];
    for (const campaignId of campaignIds) {
      const cohort = manifest.campaigns.filter(c => c.campaignId === campaignId);
      const message = config.campaigns.filter(c => c.campaignId === campaignId);
      if (cohort.length !== 1 || message.length !== 1 || !Array.isArray(cohort[0].recipients)) fail('invalid_campaign');
      for (const recipient of cohort[0].recipients) {
        if (!id(recipient.chatId) || seen.has(recipient.chatId)) fail('invalid_or_duplicate_endpoint');
        seen.add(recipient.chatId);
        recipients.push({ campaignId, chatId: recipient.chatId });
      }
      const m = message[0];
      if (requireMessages) {
        if (!['photo', 'video', 'message'].includes(m.type) || typeof m.text !== 'string' || !m.text.trim() ||
          m.text.length > (m.type === 'message' ? 4096 : 1024) ||
          (m.type !== 'message' && (typeof m.fileId !== 'string' || !/^[a-zA-Z0-9_-]{20,512}$/.test(m.fileId)))) fail('message_not_ready');
        if (m.utmConfirmed !== true || typeof m.link !== 'string' || !m.text.includes(m.link) ||
          !/^https:\/\//.test(m.link) || !m.utm ||
          !['source', 'medium', 'campaign'].every(key => typeof m.utm[key] === 'string' &&
            m.utm[key].trim().length > 0 && m.utm[key].length <= 128)) fail('utm_not_confirmed');
        // Full tracking URLs must agree with the separately recorded attribution key.
        // Short links require explicit utmConfirmed after their destination is checked.
        const query = m.link.includes('?') ? m.link.split('?')[1].split('#')[0] : '';
        if (query.includes('utm_')) {
          const params = Object.fromEntries(query.split('&').map(p => p.split('=').map(decodeURIComponent)));
          if (params.utm_source !== m.utm.source || params.utm_medium !== m.utm.medium ||
            params.utm_campaign !== m.utm.campaign) fail('utm_mismatch');
        }
      }
      messages.push({ campaignId, type: m.type, text: m.text, fileId: m.fileId,
        link: m.link, utm: m.utm, utmConfirmed: m.utmConfirmed });
    }
    if (new Set(messages.map(m => m.utm?.campaign)).size !== 4) fail('unique_utm_campaigns_required');
    recipients.sort((a, b) => a.chatId.localeCompare(b.chatId));
    const audienceHash = hash({ date: manifest.audienceSnapshotDate, recipients });
    const configHash = hash({ botId: config.botId, messages });
    return { batchId: manifest.batchId, botId: config.botId, audienceHash, configHash, recipients, messages };
  }

  function classify(response, expectedChatId) {
    if (response?.ok === true && Number.isSafeInteger(response.result?.message_id) &&
      String(response.result?.chat?.id) === expectedChatId) {
      return { status: 'accepted', messageId: response.result.message_id };
    }
    const code = Number(response?.error_code);
    const description = String(response?.description || '').toLowerCase();
    if (code === 403 && /bot was blocked by the user/.test(description)) return { status: 'blocked', errorCode: 403 };
    if ((code === 403 && /user is deactivated|bot can't initiate conversation/.test(description)) ||
      (code === 400 && /chat not found/.test(description))) return { status: 'unreachable', errorCode: code };
    if (code === 429 && Number.isInteger(response?.parameters?.retry_after) && response.parameters.retry_after > 0) {
      return { status: 'retry_wait', errorCode: 429, retryAfter: response.parameters.retry_after };
    }
    if (response?.ok === false && [400, 401, 403, 404].includes(code)) return { status: 'failed', errorCode: code };
    return { status: 'unknown', errorCode: Number.isFinite(code) ? code : null };
  }

  function api(method, payload) {
    if (transport) return transport(method, payload);
    if (typeof token !== 'string' || !/^[0-9]+:[a-zA-Z0-9_-]+$/.test(token)) fail('telegram_token_missing');
    // No redirects, custom host, token-bearing logs, or raw provider error propagation.
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      let size = 0;
      const chunks = [];
      const req = https.request({ hostname: 'api.telegram.org', port: 443,
        path: `/bot${token}/${method}`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 262144) req.destroy(new Error('response_too_large'));
          else chunks.push(chunk);
        });
        res.on('error', () => reject(new Error('telegram_transport_unknown')));
        res.on('end', () => {
          try { resolve(JSON.parse(chunks.map(c => c.toString()).join(''))); }
          catch { reject(new Error('telegram_response_unknown')); }
        });
      });
      const deadline = setTimeout(() => req.destroy(new Error('deadline')), 20000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', () => reject(new Error('telegram_transport_unknown')));
      req.end(body);
    });
  }

  function collections() {
    if (!db) fail('mongo_not_configured');
    return { batches: db.collection('tg_reactivation_batches'), rows: db.collection('tg_reactivation_recipients') };
  }
  async function matchingBatch(v) {
    const { batches } = collections();
    const batch = await batches.findOne({ _id: v.batchId });
    if (!batch || batch.botId !== v.botId || batch.configHash !== v.configHash || batch.audienceHash !== v.audienceHash) fail('immutable_batch_mismatch');
    return batch;
  }
  async function prepare(manifest, config) {
    const v = validate(manifest, config, true);
    const { batches, rows } = collections();
    await rows.createIndex({ botId: 1, chatId: 1, status: 1 });
    await rows.createIndex({ batchId: 1, status: 1, nextAttemptAt: 1 });
    ack(await batches.updateOne({ _id: v.batchId }, { $setOnInsert: {
      botId: v.botId, configHash: v.configHash, audienceHash: v.audienceHash,
      expectedCount: v.recipients.length, prepared: false, createdAt: now(),
      audienceSnapshotDate: manifest.audienceSnapshotDate,
      campaigns: v.messages.map(m => ({ campaignId: m.campaignId, utm: m.utm }))
    } }, { upsert: true }));
    await matchingBatch(v);
    for (const row of v.recipients) {
      ack(await rows.updateOne({ _id: `${v.batchId}:${row.chatId}` }, { $setOnInsert: {
        batchId: v.batchId, botId: v.botId, ...row, status: 'pending', attempts: 0, createdAt: now()
      } }, { upsert: true }));
    }
    if (await rows.countDocuments({ batchId: v.batchId }) !== v.recipients.length) fail('audience_count_mismatch');
    changed(await batches.updateOne({ _id: v.batchId, audienceHash: v.audienceHash, configHash: v.configHash },
      { $set: { prepared: true, preparedAt: now() } }));
    return report(v.batchId);
  }

  async function run(manifest, config, limit = 25, campaignId) {
    if (closed || sendEnabled !== true) fail('sending_disabled');
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) fail('invalid_batch_limit');
    if (campaignId !== undefined && !campaignIds.includes(campaignId)) fail('invalid_campaign');
    const v = validate(manifest, config, true);
    const batch = await matchingBatch(v);
    if (!batch.prepared) fail('batch_not_prepared');
    if (batch.rateLimitedUntil && batch.rateLimitedUntil > now()) fail('telegram_rate_limit_wait');
    const identity = await api('getMe', {});
    if (identity?.ok !== true || String(identity.result?.id) !== v.botId || identity.result?.is_bot !== true) fail('bot_identity_mismatch');
    const { batches, rows } = collections();
    const owner = crypto.randomUUID();
    const lockId = `lock:${v.botId}`;
    try { ack(await batches.insertOne({ _id: lockId, botId: v.botId, batchId: v.batchId, owner, startedAt: now() })); }
    catch (e) { if (e.code === 11000) fail('bot_locked'); throw e; }
    let pauseReason = null;
    // Intentionally no finally unlock: any uncertain persistence keeps the bot fenced.
    for (let i = 0; i < limit && !closed; i++) {
      const row = await rows.findOneAndUpdate({ batchId: v.batchId,
        ...(campaignId ? { campaignId } : {}),
        $or: [{ status: 'pending' }, { status: 'retry_wait', nextAttemptAt: { $lte: now() } }] },
      { $set: { status: 'sending', owner, claimedAt: now() }, $inc: { attempts: 1 } },
      { returnDocument: 'after', includeResultMetadata: false });
      if (!row) break;
      if (row.status !== 'sending' || row.owner !== owner) fail('claim_not_confirmed');
      const blockedBefore = await rows.findOne({ botId: v.botId, chatId: row.chatId, status: 'blocked' });
      if (closed) {
        // No API call began. Returning this acknowledged claim to pending is safe.
        changed(await rows.updateOne({ _id: row._id, status: 'sending', owner },
          { $set: { status: 'pending', attempts: row.attempts - 1 }, $unset: { owner: '', claimedAt: '' } }));
        break;
      }
      let outcome;
      if (blockedBefore) outcome = { status: 'suppressed_blocked', attempts: row.attempts - 1 };
      else {
        const message = v.messages.find(m => m.campaignId === row.campaignId);
        const payload = { chat_id: row.chatId };
        const method = message.type === 'message' ? 'sendMessage' : message.type === 'photo' ? 'sendPhoto' : 'sendVideo';
        if (message.type === 'message') payload.text = message.text;
        else { payload[message.type] = message.fileId; payload.caption = message.text; }
        try { outcome = classify(await api(method, payload), row.chatId); }
        catch { outcome = { status: 'unknown', errorCode: null }; }
      }
      if (outcome.status === 'retry_wait') {
        outcome.nextAttemptAt = new Date(now().getTime() + outcome.retryAfter * 1000);
        changed(await batches.updateOne({ _id: v.batchId }, { $set: { rateLimitedUntil: outcome.nextAttemptAt } }));
        if (row.attempts >= 3) outcome.status = 'failed';
      }
      changed(await rows.updateOne({ _id: row._id, status: 'sending', owner },
        { $set: { ...outcome, completedAt: now() }, $unset: { owner: '' } }));
      if (outcome.status === 'unknown' || outcome.errorCode === 401 || outcome.errorCode === 429 ||
        (outcome.status === 'failed' && [400, 404].includes(outcome.errorCode))) {
        pauseReason = outcome.status === 'retry_wait' || outcome.errorCode === 429 ? 'rate_limited' : 'send_requires_review';
        break;
      }
      await wait(1100);
    }
    if (await rows.countDocuments({ botId: v.botId, status: 'sending' })) fail('unresolved_send_lock_retained');
    const released = ack(await batches.deleteOne({ _id: lockId, owner }));
    if (released.deletedCount !== 1) fail('lock_release_failed');
    return { ...await report(v.batchId), pauseReason: closed ? 'stopped' : pauseReason };
  }

  async function recover(botId, owner, workerStopped) {
    if (!id(botId) || typeof owner !== 'string' || workerStopped !== true) fail('recovery_requires_stopped_worker');
    const { batches, rows } = collections();
    const lock = await batches.findOne({ _id: `lock:${botId}`, owner });
    if (!lock) fail('recovery_lock_mismatch');
    ack(await rows.updateMany({ botId, status: 'sending', owner }, { $set: {
      status: 'unknown', completedAt: now(), recovery: 'worker_stopped'
    }, $unset: { owner: '' } }));
    if (await rows.countDocuments({ botId, status: 'sending' })) fail('unresolved_send_lock_retained');
    const result = ack(await batches.deleteOne({ _id: lock._id, owner }));
    if (result.deletedCount !== 1) fail('lock_release_failed');
    return report(lock.batchId);
  }

  async function report(batchId) {
    const { batches, rows } = collections();
    const batch = await batches.findOne({ _id: batchId });
    if (!batch?.botId) fail('batch_missing');
    const counts = await rows.aggregate([{ $match: { batchId } }, { $group: {
      _id: { campaignId: '$campaignId', status: '$status' }, count: { $sum: 1 }, attempts: { $sum: '$attempts' }
    } }]).toArray();
    const campaigns = campaignIds.map(campaignId => {
      const status = Object.fromEntries(states.map(s => [s, 0]));
      let attempts = 0;
      for (const count of counts.filter(c => c._id.campaignId === campaignId)) {
        if (!states.includes(count._id.status)) fail('unknown_ledger_state');
        status[count._id.status] = count.count;
        attempts += count.attempts;
      }
      const eligible = Object.values(status).reduce((a, b) => a + b, 0);
      const attemptedRecipients = eligible - status.pending - status.suppressed_blocked;
      return { campaignId, eligible, attempts, attemptedRecipients, ...status,
        acceptanceRate: attemptedRecipients ? status.accepted / attemptedRecipients : null,
        purchased: null, revenueRub: null, purchaseConversion: null,
        utm: batch.campaigns?.find(c => c.campaignId === campaignId)?.utm };
    });
    const lock = await batches.findOne({ _id: `lock:${batch.botId}` });
    return { batchId, audienceSnapshotDate: batch.audienceSnapshotDate, prepared: batch.prepared,
      measuredAt: now().toISOString(), campaigns, deliveryMeaning: 'Telegram API accepted; reading not measured',
      purchasesMeaning: 'Not connected yet', lock: lock ? { batchId: lock.batchId, owner: lock.owner, startedAt: lock.startedAt } : null };
  }
  return { validate, classify, prepare, run, report, recover, stop: () => { closed = true; } };
}

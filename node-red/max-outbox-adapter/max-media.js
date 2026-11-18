'use strict';
const { isIP } = require('node:net');
const { createHash } = require('node:crypto');

const MAX_BYTES = 4 * 1024 * 1024;
const hosts = name => String(process.env[name] || '').split(',').map(x => x.trim()).filter(Boolean);
function safeUrl(value, allowed) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
    (url.port && url.port !== '443') || isIP(url.hostname) || !allowed.includes(url.hostname)) {
    throw Error('MAX_MEDIA_URL_REFUSED');
  }
  return url;
}
function validateImages(attachments, sourceHosts = hosts('SUPPORT_MAX_MEDIA_SOURCE_HOSTS')) {
  if (attachments === undefined) return [];
  if (!Array.isArray(attachments) || attachments.length > 10) throw Error('MAX_MEDIA_INVALID');
  return attachments.map(a => {
    if (!a || a.type !== 'IMAGE' || typeof a.url !== 'string' || a.url.length > 12000) throw Error('MAX_MEDIA_INVALID');
    const url = safeUrl(a.url, sourceHosts);
    const path = url.pathname.match(/\/cup-support\/v1\/[a-f0-9]{64}\/([a-f0-9]{64})\.jpg$/);
    if (!path) throw Error('MAX_MEDIA_SOURCE_REFUSED');
    url.supportSha256 = path[1];
    return url;
  });
}
async function bytes(response, maximum) {
  if (!response.body) throw Error('MAX_MEDIA_EMPTY');
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.length;
      if (total > maximum) throw Error('MAX_MEDIA_TOO_LARGE');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
async function json(response) {
  if (!response.ok) throw Error('MAX_MEDIA_UPLOAD_REFUSED');
  return JSON.parse((await bytes(response, 65536)).toString());
}

/** Uploads prepare media only. No function in this module sends a user-visible message. */
async function prepareImages(urls, token, { fetchImpl, signal,
  uploadHosts = ['iu.oneme.ru', 'fu.oneme.ru'], admitUpload = operation => operation() } = {}) {
  const result = [];
  let total = 0;
  for (const source of urls) {
    if (signal.aborted) throw Error('MAX_MEDIA_ABORTED');
    const response = await fetchImpl(source, { method: 'GET', redirect: 'error', signal });
    if (!response.ok) throw Error('MAX_MEDIA_DOWNLOAD_REFUSED');
    const content = await bytes(response, MAX_BYTES); total += content.length;
    if (total > 12 * 1024 * 1024) throw Error('MAX_MEDIA_TOO_LARGE');
    if (createHash('sha256').update(content).digest('hex') !== source.supportSha256) throw Error('MAX_MEDIA_CONTENT_CHANGED');
    // CUP stores normalized JPEG. Reject HTML, SVG, WebP and forged MIME before uploading.
    if (content.length < 4 || content[0] !== 0xff || content[1] !== 0xd8 || content[2] !== 0xff) throw Error('MAX_MEDIA_FORMAT_INVALID');
    const admitted = await admitUpload(() => fetchImpl(new URL('https://platform-api2.max.ru/uploads?type=image'), {
      method: 'POST', redirect: 'error', headers: { Authorization: token }, signal,
    }));
    if (!admitted) throw Error('MAX_MEDIA_UPLOAD_DEFERRED');
    const upload = await json(admitted);
    const uploadUrl = safeUrl(upload.url, uploadHosts);
    const form = new FormData();
    form.append('data', new Blob([content], { type: 'image/jpeg' }), 'photo.jpg');
    // Upload URLs are signed by MAX. Never disclose the bot Authorization header to that host.
    const uploaded = await json(await fetchImpl(uploadUrl, { method: 'POST', redirect: 'error', body: form, signal }));
    const photos = uploaded && uploaded.photos && typeof uploaded.photos === 'object' ? Object.values(uploaded.photos) : [];
    const tokens = photos.filter(p => p && typeof p.token === 'string' && p.token.length > 0 && p.token.length <= 20000);
    if (tokens.length !== 1 || photos.length !== 1) throw Error('MAX_MEDIA_TOKEN_MISSING');
    result.push({ type: 'image', payload: { token: tokens[0].token } });
  }
  return result;
}
module.exports = { validateImages, prepareImages, safeUrl, bytes };

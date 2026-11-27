import crypto from 'node:crypto';
import util from 'node:util';
import { historyActorAllowed } from './stationMessageHistory.mjs';
import { smEqual, smId, smKeys, smMongoIdentity, smStream, smUuid } from './stationMembershipLifetime.mjs';
import { requestKey, stationMessageReceiptProof, stationPhotoValid, STATION_PHOTO_MAX_BYTES } from './stationMessageProof.mjs';

export const STATION_PHOTO_ROUTE = '/lk/communities/:communityId/message-photos';

const photoDigest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export async function prepareStationPhoto(body, sharp) {
  if (!smKeys(body, ['requestId', 'caption', 'jpeg']) || !smUuid(body.requestId) || body.requestId.length !== 36 ||
      typeof body.caption !== 'string' || body.caption.length > 8000 || typeof body.jpeg !== 'string' ||
      body.jpeg.length > 4 * Math.ceil(STATION_PHOTO_MAX_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.jpeg)) {
    throw Error('STATION_PHOTO_INVALID');
  }
  const input = Buffer.from(body.jpeg, 'base64');
  if (input.length > STATION_PHOTO_MAX_BYTES || input.length < 4 ||
      input[0] !== 255 || input[1] !== 216 || input.toString('base64') !== body.jpeg) throw Error('STATION_PHOTO_INVALID');

  const image = sharp(input, { limitInputPixels: 1600 * 1600, failOn: 'warning' });
  const metadata = await image.metadata();
  if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height ||
      metadata.width > 1600 || metadata.height > 1600) throw Error('STATION_PHOTO_INVALID');
  const bytes = await image.rotate().jpeg({ quality: 72 }).toBuffer();
  const caption = body.caption.trim();
  const photo = { sha256: photoDigest(bytes), size: bytes.length, hasCaption: Boolean(caption) };
  if (!stationPhotoValid(photo)) throw Error('STATION_PHOTO_INVALID');
  return { requestId: body.requestId, text: caption || 'Фото', photo, bytes };
}

function stationPhotoObjectKey(id, photo) {
  if (!smUuid(id) || id.length !== 36 || !stationPhotoValid(photo)) throw Error('STATION_PHOTO_INVALID');
  return 'lk-station-chat/v1/' + id + '/' + photo.sha256 + '.jpg';
}

function checkStationPhotoBytes(photo, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== photo.size || photoDigest(bytes) !== photo.sha256) {
    throw Error('STATION_PHOTO_INTEGRITY');
  }
}

async function getStationPhotoObject(storage, input, photo) {
  const signal = util.transferableAbortController().signal.constructor.timeout(5000);
  const response = await storage.client.send(new storage.sdk.GetObjectCommand(input), { abortSignal: signal });
  const { Body: body } = response;
  try {
    if (response.ContentType !== 'image/jpeg' || response.ContentLength !== photo.size) throw Error('STATION_PHOTO_INTEGRITY');
    const chunks = [];
    let received = 0;
    const abort = () => body.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      for await (const chunk of body) {
        received += chunk.length;
        if (received > photo.size) throw Error('STATION_PHOTO_INTEGRITY');
        chunks.push(chunk);
      }
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', abort);
    }
    const bytes = Buffer.concat(chunks, received);
    checkStationPhotoBytes(photo, bytes);
    return bytes;
  } finally {
    body?.destroy();
  }
}

export function readStationPhotoObject(storage, id, photo) {
  return getStationPhotoObject(storage, { Bucket: storage.bucket, Key: stationPhotoObjectKey(id, photo) }, photo);
}

export async function putStationPhotoObject(storage, id, photo, bytes) {
  checkStationPhotoBytes(photo, bytes);
  const input = { Bucket: storage.bucket, Key: stationPhotoObjectKey(id, photo) };
  try {
    await storage.client.send(new storage.sdk.PutObjectCommand({
      ...input,
      Body: bytes,
      ContentLength: photo.size,
      ContentType: 'image/jpeg',
      ChecksumSHA256: Buffer.from(photo.sha256, 'hex').toString('base64'),
      IfNoneMatch: '*',
    }), { abortSignal: util.transferableAbortController().signal.constructor.timeout(5000) });
  } catch {
    // On a precondition failure or a lost ACK the same digest must already exist.
    // This never authorizes a second write or an overwrite.
    await getStationPhotoObject(storage, input, photo);
  }
  return true;
}

export function stationPhotoReadRequest(params, query, actor) {
  if (!smId(params?.communityId) || !smUuid(params?.messageId) || params.messageId.length !== 36 || Object.keys(query || {}).length || !smId(actor?.id)) {
    throw Error('STATION_PHOTO_REQUEST_INVALID');
  }
  return { communityId: params.communityId, messageId: params.messageId, actor: { id: actor.id } };
}

export function stationPhotoMessageAllowed(request, row) {
  if (!row || row.communityId !== request.communityId || row.id !== request.messageId ||
      !smId(row.actorId) || !smUuid(row.requestId) || !stationPhotoValid(row.photo)) return false;
  return stationMessageReceiptProof({
    key: requestKey(row.actorId, row.requestId), requestId: row.requestId, actorId: row.actorId, communityId: request.communityId,
  }, row);
}

export function stationPhotoAccess(request, community, message) {
  try {
    if (!historyActorAllowed(community, request.actor) || community.id !== request.communityId) return false;
    const identity = smMongoIdentity(community);
    if (!identity || !smEqual(identity, message.communityIdentity)) return false;
    if (message.streamId === undefined) return true;
    const stream = smStream(community);
    return stream?.streamId === message.streamId && stream.publishedSequence >= message.sequence;
  } catch { return false; }
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { prepareStationPhoto, putStationPhotoObject, readStationPhotoObject, stationPhotoAccess, stationPhotoMessageAllowed } from '../lib/stationChatPhotos.mjs';
import { beginStationMessage, recoverStationMessageOutbox, runStationMessage } from '../lib/stationMessageOwner.mjs';
import { stationStreamAdoptionPlan } from '../lib/stationMessageStream.mjs';
import { messageDb, uid } from './helpers/stationMessageHarness.mjs';

const bytes = Buffer.from([255, 216, 255, 217]);
const photo = {
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
  hasCaption: false,
};
const actor = { id: 'player-a' };
const communities = 'lk_communities';
const messages = 'lk_community_chat_messages';
const community = db => db.tables.get(communities)[0];

function operation(db, overrides = {}) {
  return beginStationMessage({ communityId: community(db).id, actor, requestId: uid(1), text: 'Фото', photo, ...overrides });
}

test('preparation accepts a single bounded decoded JPEG and removes the empty caption', async () => {
  const body = { requestId: uid(2), caption: '  ', jpeg: bytes.toString('base64') };
  const image = {
    metadata: async () => ({ format: 'jpeg', width: 10, height: 1600 }),
    rotate: () => image,
    jpeg: options => { assert.equal(options.quality, 72); return image; },
    toBuffer: async () => bytes,
  };
  assert.deepEqual(await prepareStationPhoto(body, () => image), { requestId: body.requestId, text: 'Фото', photo, bytes });
  assert.equal((await prepareStationPhoto({ ...body, caption: ' Фото ' }, () => image)).photo.hasCaption, true);
  for (const input of [{ ...body, jpeg: '<svg>' }, { ...body, jpeg: 'eHh4eA==' }, { ...body, jpeg: 'A'.repeat(700000) }, { ...body, url:'https://example.test/photo' }]) {
    await assert.rejects(prepareStationPhoto(input, () => assert.fail('invalid upload reached decoder')));
  }
  await assert.rejects(prepareStationPhoto(body, () => ({ ...image, metadata: async () => ({ format: 'jpeg', width: 1601, height: 1 }) })));
});

function storageHarness() {
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class PutObjectCommand { constructor(input) { this.input = input; } }
  const harness = { read: bytes, put: null, loseAck: true };
  const client = { async send(command) {
    if (command instanceof PutObjectCommand) {
      harness.put = command.input;
      if (harness.loseAck) throw Error('lost ACK');
      return {};
    }
    assert.equal(harness.put.Key, command.input.Key);
    return { ContentType: 'image/jpeg', ContentLength: photo.size, Body: Readable.from([harness.read]) };
  }};
  return { harness, storage:{ sdk:{GetObjectCommand,PutObjectCommand}, client, bucket:'fixture' } };
}

test('object writes are conditional and a missing ACK requires byte-for-byte readback', async () => {
  const { harness, storage } = storageHarness();
  assert.equal(await putStationPhotoObject(storage, uid(4), photo, bytes), true);
  assert.equal(harness.put.IfNoneMatch, '*');
  assert.equal(harness.put.ChecksumSHA256, Buffer.from(photo.sha256,'hex').toString('base64'));
  assert.equal(harness.put.Key, 'lk-station-chat/v1/' + uid(4) + '/' + photo.sha256 + '.jpg');
  assert.deepEqual(await readStationPhotoObject(storage, uid(4), photo), bytes);
  harness.read = Buffer.alloc(bytes.length);
  await assert.rejects(putStationPhotoObject(storage, uid(4), photo, bytes), /INTEGRITY/);
  harness.read = Buffer.alloc(bytes.length + 1);
  await assert.rejects(readStationPhotoObject(storage, uid(4), photo), /INTEGRITY/);
});

test('storage failure leaves a hidden reservation, retry commits once and rejects changed media, caption or mode', async () => {
  const db = messageDb();
  const denied = await runStationMessage(db, operation(db, { actor:{id:'intruder'} }), { storePhoto: () => assert.fail('S3 must not be reached') });
  assert.equal(denied.response.status, 403);
  const failed = await runStationMessage(db, operation(db), { storePhoto: async () => false });
  assert.equal(failed.response.status, 503);
  assert.equal(db.tables.get(messages)[0].state, 'RESERVED');
  assert.equal(db.tables.get(messages)[0].photo, undefined);
  const sent = await runStationMessage(db, operation(db), { storePhoto: async () => true });
  const retried = await runStationMessage(db, operation(db), { storePhoto: () => assert.fail('a committed message must not upload again') });
  assert.equal(sent.response.status, 200);
  assert.deepEqual(sent.response.body, retried.response.body);
  assert.deepEqual(sent.response.body.message.photo, {hasCaption:false});
  assert.equal(db.tables.get(messages).length, 1);
  for (const override of [{ photo: { ...photo, sha256:'0'.repeat(64) } }, {photo:{...photo,hasCaption:true}}, { photo:undefined }]) {
    assert.equal((await runStationMessage(db, operation(db, override))).response.status, 409);
  }
});

test('accepted photo recovers through the existing worker and waits for stream publication', async () => {
  const db = messageDb();
  Object.assign(community(db), stationStreamAdoptionPlan(community(db), uid(8)).update.$set);
  const sent = await runStationMessage(db, operation(db), {
    storePhoto: async () => true,
    before: op => op.ctx.step === 'event_write' ? { skip:true, error:true } : undefined,
  });
  assert.equal(sent.response.status, 503);
  const row = db.tables.get(messages)[0];
  const request = { communityId:community(db).id, messageId: row.id, actor };
  assert.equal(stationPhotoMessageAllowed(request, row), true);
  assert.equal(stationPhotoAccess(request, community(db), row), false);
  assert.equal((await recoverStationMessageOutbox(db, { dryRun:false })).recovered, 1);
  const station = community(db);
  assert.equal(stationPhotoAccess(request, station, row), true);
  assert.equal(stationPhotoAccess({ ...request, actor:{id:'intruder'} }, station, row), false);
  assert.equal(stationPhotoAccess(request, {...station, _id:'different'}, row), false);
  assert.equal(stationPhotoAccess(request, {...station, bannedMembers:[actor]}, row), false);
  assert.equal(stationPhotoMessageAllowed({...request, communityId:'other-station'}, row), false);
  assert.equal(stationPhotoMessageAllowed(request, {...row, photo:{...photo, size:photo.size+1}}), false);
});

test('departure during storage prevents acceptance', async () => {
  const db = messageDb();
  const result = await runStationMessage(db, operation(db), {
    storePhoto: async () => { community(db).members = []; return true; },
  });
  assert.equal(result.response.status, 403);
  assert.equal(db.tables.get(messages)[0].state, 'RESERVED');
});

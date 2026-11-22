import assert from 'node:assert/strict';
import test from 'node:test';
import { isolatedStorage } from './previewIsolation.ts';

test('preview storage cannot read, overwrite or clear a real LK cache or token', () => {
  const data = new Map([['access_token', 'real-sentinel'], ['padlhub.pendingPaymentSyncQueue.v1', 'real-queue']]);
  const backing = { get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); }, clear: () => data.clear() } as Storage;
  const preview = isolatedStorage(backing);
  assert.equal(preview.getItem('access_token'), null);
  assert.equal(preview.access_token, undefined);
  preview.setItem('access_token', 'demo-token');
  preview['padlhub.pendingPaymentSyncQueue.v1'] = 'demo-queue';
  assert.equal(preview.length, 2);
  assert.equal(preview.getItem('access_token'), 'demo-token');
  assert.equal(preview.key(0), 'access_token');
  assert.deepEqual(Object.keys(preview).sort(), ['access_token', 'padlhub.pendingPaymentSyncQueue.v1']);
  delete preview.access_token;
  assert.equal(preview.getItem('access_token'), null);
  preview.clear();
  assert.equal(preview.length, 0);
  assert.equal(data.get('access_token'), 'real-sentinel');
  assert.equal(data.get('padlhub.pendingPaymentSyncQueue.v1'), 'real-queue');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventAccess } from '../../games/padel-jump/live/event-access.mjs';
import { eventJumpAdmission } from '../lib/eventJumpAdmission.mjs';
const epoch = '2026-11-09T09:00:00.000Z', current = Date.parse('2026-11-12T09:00:00.000Z');
const policy = { version: 'event-registration-v1', responsibleName: 'Synthetic Organizer', contactEmail: ['organizer', 'example.invalid'].join('@'), startsAt: '2026-11-11T21:00:00.000Z', endsAt: '2026-11-13T21:00:00.000Z', retentionYears: 1 };
const event = { epoch, policyRevision: 2, startsAt: policy.startsAt, endsAt: policy.endsAt, retentionUntil: '2027-11-13T21:00:00.000Z', inviteCode: 'fixture-invite' };
const form = { fullName: 'Private Participant', company: 'Private Company', email: ['participant', 'example.invalid'].join('@'), policyRevision: 2 };
const req = { headers: { authorization: 'Bearer fixture-owner-token' } };
type Member = { id: string; status?: string; role?: string };
function fixture(perpetual=false) {
  const directory = mkdtempSync(join(tmpdir(), 'event-access-'));
  const doc = { id: 'fixture-event', name: 'Synthetic Event', communityType: 'EVENT', members: [{ id: 'fixture-player', status: 'ACTIVE', role: 'MEMBER' }] as Member[], pendingMembers: [] as Member[], bannedMembers: [] as Member[], typeSettingsEffectiveAt: epoch, typeSettingsRevision: 2, typeSettings: { gameIds: ['padel-jump'], registrationPolicy: structuredClone(policy) }, eventEntries: [] as Record<string, unknown>[] };
  if(perpetual) doc.id='community_1794221739126_корпспорт-падлхаб-2026';
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher = async (url: string, options: { method?: string; body?: string }) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/join-by-invite')) {
      const body = JSON.parse(options.body!); assert.equal(body.inviteCode, event.inviteCode); assert.equal(body.member.id, 'fixture-player');
      if(perpetual && body.eventRegistration.retentionMode!=='submitted-year-v1') return new Response(JSON.stringify({error:'EVENT_REGISTRATION_REQUIRED'}),{status:422});
      doc.eventEntries = [{ ...body.eventRegistration, playerId: 'fixture-player', epoch, policyVersion: policy.version, registeredAt: new Date(current).toISOString(), retentionUntil: perpetual?'2027-11-12T09:00:00.000Z':event.retentionUntil }];
      return new Response(JSON.stringify({ ok: true }));
    }
    assert.equal(String(url), 'https://padlhub.su/lk/communities/'+encodeURIComponent(doc.id)+'/event-admission');
    return new Response(JSON.stringify(eventJumpAdmission(doc, { id: 'fixture-player', name: 'Verified Profile' }, new Date(current).toISOString())));
  };
  return { directory, doc, calls, access: createEventAccess({ communityId: doc.id, event, fetcher, now: () => current }), close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('an active member must complete canonical EVENT registration before direct game authentication', async () => {
  const h = fixture(); try {
    assert.equal((await h.access.enrollment.status(req)).state, 'form');
    await assert.rejects(h.access.authenticate(req), /EVENT_REGISTRATION_REQUIRED/);
    assert.equal((await h.access.enrollment.submit(req, form)).state, 'ready');
    const actor = await h.access.authenticate(req, { fresh: true });
    assert.equal(actor.id, 'fixture-player'); assert.equal(actor.eventEpoch, epoch); assert.equal(actor.policyRevision, 2);
    assert.equal(h.doc.eventEntries.length, 1); assert.equal(h.doc.eventEntries[0].email, form.email);
    assert.deepEqual(readdirSync(h.directory), []);
    assert.ok(h.calls.every(call => !call.url.includes('vivacrm')));
  } finally { h.close(); }
});
test('exhibition bridge preserves the rolling notice and never manufactures client consent',async()=>{
  const h=fixture(true);try {
    const before=await h.access.enrollment.status(req);
    assert.equal(before.eventNotice.retentionMode,'submitted-year-v1');
    await assert.rejects(h.access.enrollment.submit(req,form),/EVENT_REGISTRATION_REQUIRED/);
    assert.equal(h.calls.filter(c=>c.method==='POST').length,0,'old form clients must not collect under a different notice');
    assert.equal((await h.access.enrollment.submit(req,{...form,retentionMode:'submitted-year-v1'})).state,'ready');
    const post=h.calls.find(c=>c.method==='POST')!;
    assert.equal((post.body as {eventRegistration:{retentionMode:string}}).eventRegistration.retentionMode,'submitted-year-v1');
    assert.equal((await h.access.authenticate(req,{fresh:true})).id,'fixture-player');
    assert.deepEqual(readdirSync(h.directory),[],'canonical EVENT remains the only form store');
  } finally {h.close();}
});
test('bans, pending status, stale policy and client-selected identity cannot use the exhibition bridge', async () => {
  for (const kind of ['ban', 'pending', 'policy', 'spoof']) {
    const h = fixture(); try {
      if (kind === 'ban') h.doc.bannedMembers.push({ id: 'fixture-player' });
      if (kind === 'pending') { h.doc.members = []; h.doc.pendingMembers.push({ id: 'fixture-player' }); }
      if (kind === 'policy') h.doc.typeSettingsRevision = 3;
      if (kind === 'spoof') assert.throws(() => h.access.enrollment.submit(req, { ...form, actorId: 'other' }));
      else { await assert.rejects(h.access.authenticate(req)); if (kind === 'policy') await assert.rejects(h.access.enrollment.status(req)); }
      assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
    } finally { h.close(); }
  }
});

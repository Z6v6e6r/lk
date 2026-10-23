import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = path => fs.readFileSync(path, 'utf8');
const authSource = read('scripts/nodered_auth_consent_nodes/fn_auth_consent_build_upsert.js');
const context = () => ({ documentSetVersion: '2026-07-14', documents: [],
  verifiedTokenContext: { authorizedParty: 'widget', tenantKey: 'iSkq6G' } });
function verify(payload, statusCode = 200, extra = {}) {
  const warnings = [];
  const msg = { statusCode, payload, headers: { 'content-type': 'application/json' }, _authConsent: context(), ...extra };
  const ports = new Function('msg', 'node', authSource)(msg, { warn: text => warnings.push(JSON.parse(text)) });
  return { ports, warnings };
}

test('userinfo accepts valid JSON text and object, but never trusts malformed claims', () => {
  for (const payload of [{ sub: 'fixture-subject' }, '{"sub":"fixture-subject"}']) {
    const { ports, warnings } = verify(payload);
    assert.equal(ports[1], null);
    assert.equal(ports[0].payload[1].$setOnInsert.subject, 'fixture-subject');
    assert.deepEqual(warnings, []);
  }
  for (const payload of ['', 'not-json', '[]', '{}', 'null', '"subject"', { sub: {} }, { sub: 7 }, { sub: '' }, []]) {
    const { ports, warnings } = verify(payload);
    assert.equal(ports[0], null);
    assert.equal(ports[1].statusCode, 503);
    assert.equal(ports[1].payload.code, 'AUTH_SERVICE_UNAVAILABLE');
    assert.ok(['json_invalid', 'claims_invalid'].includes(warnings[0].reason));
  }
});

test('userinfo separates rejected credentials from dependency and transport failures', () => {
  for (const status of [401, 403, 302, 404, 429, 500, 502, 0, NaN]) {
    const { ports, warnings } = verify('{"sub":"must-not-write"}', status);
    assert.equal(ports[0], null);
    assert.equal(ports[1].statusCode, [401, 403].includes(status) ? 401 : 503);
    assert.equal(warnings[0].retryable, ![401, 403].includes(status));
  }
  assert.equal(verify('{"sub":"must-not-write"}', 200, { error: { message: 'fixture-network' } }).ports[1].statusCode, 503);
});

test('userinfo diagnostics contain fixed enums and bounded status only', () => {
  const sensitive = 'fixture-sensitive';
  const { warnings, ports } = verify(sensitive, 200, {
    headers: { 'content-type': `text/html; ${sensitive}`, authorization: sensitive },
    req: { headers: { authorization: sensitive } },
  });
  assert.deepEqual(warnings, [{ event: 'auth_consent_verification_failed', code: 'AUTH_SERVICE_UNAVAILABLE',
    reason: 'json_invalid', upstreamStatus: 200, responseType: 'html', retryable: true }]);
  assert.ok(!JSON.stringify([warnings, ports[1].payload]).includes(sensitive));
});

test('SMS password grant requests OIDC scope while refresh preserves its original grant', () => {
  const text = read('src/context/VivaAuthProvider.tsx');
  const file = ts.createSourceFile('provider.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const grants = new Map();
  function visit(node) {
    if (ts.isNewExpression(node) && node.expression.getText(file) === 'URLSearchParams') {
      const arg = node.arguments?.[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const props = new Map(arg.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(file), p.initializer]));
        const grant = props.get('grant_type');
        if (grant && ts.isStringLiteral(grant)) grants.set(grant.text, props);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(grants.get('password')?.get('scope')?.text, 'openid');
  assert.equal(grants.get('refresh_token')?.has('scope'), false);
});

const router = read('scripts/nodered_subscription_price_preview_nodes/router.js');
const final = read('scripts/nodered_subscription_price_preview_nodes/final.js');
function exercisePreview(change = {}, category = 'TOURNAMENT', status = 200) {
  const exercise = { id: 'fixture-event', category: category === 'TOURNAMENT' ? 'tournament' : 'group_training',
    startsAt: '2099-01-01T10:00:00+03:00', duration: 90, roomId: 'fixture-room', studioId: 'fixture-studio', type: 1, ...change };
  const canonical = { isObj: x => x && typeof x === 'object', identityMoneyOwned() {}, unwrapRecord: x => x, eventStartsAt: x => x?.startsAt,
    eventDurationMinutes: x => x?.duration, resolveCategory: x => x.category,
    exerciseRoomId: x => x.roomId, managedExternalEventTypeId: x => x.type, isProTrainingExercise: () => false };
  const ctx = { step: 'groupExercise', exerciseId: 'fixture-event', eventCategory: category, tenantKey: 'fixture', startedAt: Date.now(), target: {} };
  const msg = { statusCode: status, payload: change === null ? null : exercise, _subscriptionPricePreview: ctx };
  const ports = new Function('msg', 'canonical', router)(msg, canonical);
  return { msg, ctx, ports };
}

test('event target diagnostics identify every guard without weakening the refusal', () => {
  const cases = [[null, 200, 'target_missing'], [{}, 502, 'target_upstream_error'], [{ id: 'other' }, 200, 'target_identity'],
    [{ category: 'other' }, 200, 'target_category'], [{ startsAt: 'invalid' }, 200, 'target_start_invalid'],
    [{ startsAt: '2000-01-01T00:00:00Z' }, 200, 'target_not_future'], [{ duration: 0 }, 200, 'target_duration'],
    [{ roomId: null }, 200, 'target_room'], [{ studioId: null }, 200, 'target_studio'],
    [{ type: null }, 200, 'target_type'], [{ isCancelled: true }, 200, 'target_cancelled'],
    [{ status: 'FINISHED' }, 200, 'target_lifecycle']];
  for (const category of ['TOURNAMENT', 'GROUP_TRAINING']) {
    for (const [patch, status, reason] of cases) {
      const { msg, ctx, ports } = exercisePreview(patch, category, status);
      assert.equal(ports[4], msg);
      assert.equal(ctx.statusCode, 503);
      assert.equal(ctx.errorDetails.reason, reason);
      assert.equal(ctx.errorDetails.upstreamStatus, status);
      assert.equal(ctx.error, `${category === 'TOURNAMENT' ? 'TOURNAMENT' : 'GROUP'}_DISCOUNT_TARGET_UNRESOLVED`);
      const warnings = [];
      new Function('msg', 'node', final)(msg, { warn: x => warnings.push(JSON.parse(x)) });
      assert.equal(msg.statusCode, 503);
      assert.equal(warnings[0].reason, reason);
      assert.equal(warnings[0].upstreamStatus, status);
      assert.ok(!JSON.stringify(warnings).includes('fixture-room'));
    }
  }
  const valid = exercisePreview();
  assert.equal(valid.ports[0], valid.msg);
  assert.equal(valid.ctx.step, 'subscriptions');
  assert.equal(valid.msg.method, 'GET');
});

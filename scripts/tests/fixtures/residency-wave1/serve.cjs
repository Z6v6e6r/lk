'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const lk = path.resolve(__dirname, '../../../..');
const [cup, runtime, userDir, mongoPort = '24643', lkPort = '24641', cupPort = '24642'] = process.argv.slice(2);
for (const port of [mongoPort, lkPort, cupPort]) assert(/^[1-9][0-9]{3,4}$/.test(port));
assert.equal(new Set([mongoPort, lkPort, cupPort]).size, 3);
const mongoUri = 'mongodb://127.0.0.1:' + mongoPort + '/?directConnection=true';
const lkOrigin = 'http://127.0.0.1:' + lkPort;
const cupOrigin = 'http://127.0.0.1:' + cupPort;

process.env.TS_NODE_PROJECT = path.join(cup, 'tsconfig.json');
const fromCup = createRequire(path.join(cup, 'package.json'));
fromCup('ts-node/register/transpile-only');
fromCup('reflect-metadata');
const { Module, UnauthorizedException, ValidationPipe } = fromCup('@nestjs/common');
const { NestFactory } = fromCup('@nestjs/core');
const { MongoClient } = fromCup('mongodb');
const express = fromCup('express');
const RED = require(path.join(runtime, 'node_modules/node-red'));
const cupSource = name => require(path.join(cup, 'src/subscriptions', name + '.ts'));
const loadLk = name => import(pathToFileURL(path.join(lk, name)).href);
const readLk = name => fs.readFileSync(path.join(lk, name), 'utf8');
const { SubscriptionTrustedShadowController } = cupSource('subscriptions.controller');
const { ResidencyObservationRepository } = cupSource('residency-observation.repository');
const { ResidencyPurchasePolicyService } = cupSource('residency-purchase-policy.service');
const { SubscriptionRuntimeContextService } = cupSource('subscription-runtime-context.service');
const { SUBSCRIPTION_RUNTIME_REQUIRED_INDEXES } = cupSource('subscriptions.repository');
const { computeSubscriptionRuntimeProjectionDigest } = cupSource('subscription-runtime-contracts');
const { buildSubscriptionProjectionFence } = cupSource('subscription-projection-fence');
const { bindingFixture, actor } = require(path.join(cup, 'test/residency-provider-sync.test.ts'));
const { RESIDENCY_PRODUCT_ID: productId } = cupSource('residency-booking-policy');

const dbName = 'residency_wave1_stand';
const integrationToken = 'fixture-only-no-provider-access-'.repeat(2);
const cupPath = '/api/internal/subscriptions/residency-purchase-policy';
const canonicalCupUrl = 'https://padlhub.su' + cupPath;
const quotePath = '/lk/subscriptions/game-price-preview';
const exerciseId = '4c9f00aa-d286-4a48-ad29-98757bd0ca87';
const stationId = '588b6151-f4f5-47d9-9449-80edf8cbc748';
const externalEventTypeId = 'viva:direction:3685:type:605';
const tariffId = 'd52bc36c-14bb-419b-8601-6f5f33bd1a07';
const startsAtMs = Math.ceil(Date.now() / 3600000) * 3600000 + 86400000;
const target = { exerciseId, stationId, externalEventTypeId, startsAt: new Date(startsAtMs).toISOString(), durationMinutes: 60 };
const actors = new Map(Object.entries({
  'Bearer fixture-first': { clientId: '10000000-0000-4000-8000-000000000001', state: 'NONE' },
  'Bearer fixture-active': { clientId: '10000000-0000-4000-8000-000000000002', state: 'ACTIVE' },
  'Bearer fixture-unavailable': { clientId: '10000000-0000-4000-8000-000000000003', state: 'UNAVAILABLE' },
}));
const settings = {
  subscriptions_residency_purchase_quote_enabled: true,
  subscriptions_runtime_environment: 'PROD',
  subscriptions_runtime_api_base_url: 'https://padlhub.su/api',
  subscriptions_runtime_context_integration_token: integrationToken,
};

Object.assign(process.env, {
  SUBSCRIPTIONS_MONGODB_URI: mongoUri,
  SUBSCRIPTIONS_MONGODB_DB: dbName,
  SUBSCRIPTIONS_RESIDENCY_PURCHASE_POLICY_ENABLED: 'true',
  SUBSCRIPTIONS_RUNTIME_CONTEXT_ENABLED: 'true',
  SUBSCRIPTIONS_RUNTIME_TENANT_ID: actor.tenantId,
  SUBSCRIPTIONS_RUNTIME_HASH_PEPPER: 'fixture-only-cup-hash-pepper-'.repeat(3),
  SUBSCRIPTIONS_RUNTIME_CONTEXT_INTEGRATION_TOKEN: integrationToken,
});
const traces = new Map();

async function dispatch(msg) {
  assert.equal(msg.followRedirects, false);
  const auth = msg.headers.Authorization;
  const player = actors.get(auth);
  const request = new URL(msg.url);
  const actualTrace = traces.get(msg.req.headers['x-stand-trace']);
  const record = key => actualTrace?.push(key);
  // The only HTTP destination is the Nest loopback handler. There is no generic outbound client.
  msg.responseUrl = msg.url;
  msg.statusCode = 200;
  if (msg.url === canonicalCupUrl) {
    assert.equal(msg.method, 'POST');
    assert.deepEqual(JSON.parse(JSON.stringify(msg.payload)), target);
    record('CUP_POLICY_HTTP');
    const response = await fetch(cupOrigin + cupPath, {
      method: 'POST', headers: msg.headers, body: JSON.stringify(msg.payload), redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    msg.statusCode = response.status;
    msg.payload = await response.json();
    return msg;
  }
  assert.equal(request.origin, 'https://api.vivacrm.ru');
  assert.equal(msg.method, 'GET');
  assert.equal(msg.headers['X-Subscriptions-Integration-Token'], undefined);
  if (!player) {
    record('PROFILE_REFUSED');
    msg.statusCode = 401;
    msg.payload = {};
  } else if (request.pathname.endsWith('/profile')) {
    record('PROFILE_FIXTURE');
    msg.payload = { id: player.clientId };
  } else if (request.pathname.endsWith('/exercises/' + exerciseId)) {
    record('EXERCISE_FIXTURE');
    msg.payload = {
      id: exerciseId, studioId: stationId, roomId: stationId, directionId: 3685, typeId: 605,
      timeFrom: target.startsAt, timeTo: new Date(startsAtMs + 3600000).toISOString(),
    };
  } else if (request.pathname.endsWith('/subscriptions')) {
    record('SUBSCRIPTIONS_FIXTURE');
    assert.equal(request.searchParams.get('includeFinished'), 'true');
    if (player.state === 'UNAVAILABLE') {
      msg.statusCode = 503;
      msg.payload = { code: 'FIXTURE_READ_UNAVAILABLE' };
    } else {
      const content = player.state === 'ACTIVE' ? [{ status: 'ACTIVE', productId, clientId: player.clientId }] : [];
      msg.payload = { content, number: 0, totalPages: content.length, totalElements: content.length };
    }
  } else if (request.pathname.endsWith('/products/one-times')) {
    record('TARIFF_FIXTURE');
    assert.equal(request.searchParams.get('exerciseId'), exerciseId);
    msg.payload = [{ id: tariffId, cost: 550000, productType: 'SERVICE', exerciseId }];
  } else if (request.pathname.endsWith('/products/subscriptions/' + productId)) {
    record('RESIDENCY_CARD_FIXTURE');
    msg.payload = {
      id: productId, cost: 79000, type: 'GROUP', variant: 'BY_VISITS', appliesTo: 'BOOKING', validityDays: 30,
      visits: 30, activationDays: 0, hasStudioLimitation: false, hasDirectionLimitation: false, hasDayLimitation: false,
      hasTimeRangeLimitation: false, hasDayTimeLimitation: false, hasTypeLimitation: true, availableTypes: [{ id: 2572 }],
    };
  } else {
    assert.fail('Unexpected fixture request: ' + request.pathname);
  }
  return msg;
}

async function previewFlow() {
  const { extractSubscriptionPricePreviewSource } = await loadLk('scripts/lib/subscriptionPricePreviewSources.mjs');
  const { proTrainingExclusionSource, spanishTrainingExclusionSource } = await loadLk('scripts/lib/eventPaymentSources.mjs');
  const roots = ['isObj', 'unwrapRecord', 'resolveCategory', 'eventStartsAt', 'eventDurationMinutes',
    'exerciseRoomId', 'managedExternalEventTypeId', 'collectExactProductIds', 'hasCompleteBookingList', 'extractItems'];
  const { source } = extractSubscriptionPricePreviewSource({
    source: readLk('scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js'), roots,
  });
  const canonical = [
    source, proTrainingExclusionSource(), spanishTrainingExclusionSource(),
    'const canonical = {' + roots.concat('isProTrainingExercise', 'isSpanishTrainingExercise').join(',') + ',',
    'identityMoneyOwned: () => { throw new Error("Unexpected existing-subscription path"); }};',
  ].join('\n');
  const body = name => readLk('scripts/nodered_subscription_price_preview_nodes/' + name + '.js');
  const fn = (id, func, wires) => ({ id, z: 'stand', name: id, type: 'function', func, outputs: wires.length, wires });
  const flow = [
    { id: 'stand', type: 'tab', label: 'First residency, isolated', disabled: false },
    { id: 'input', z: 'stand', type: 'http in', name: 'Group training preview', method: 'post', url: quotePath, wires: [['entry']] },
    fn('entry', body('entry'), [['router']]),
    fn('router', canonical + '\n' + body('router'), [['isolated-read'], ['unexpected'], ['unexpected'], ['unexpected'], ['final'], ['unexpected']]),
    fn('isolated-read', 'return await global.get("dispatchStandRead")(msg);', [['router']]),
    fn('unexpected', 'throw new Error("Unexpected non-preview graph output");', []),
    fn('final', body('final'), [['output']]),
    { id: 'catch-fixture', z: 'stand', type: 'catch', scope: null, uncaught: false, wires: [['fixture-error']] },
    fn('fixture-error', 'msg.statusCode = 500; msg.headers = {}; msg.payload = {error:{code:"STAND_FIXTURE_FAILED"}}; return msg;', [['output']]),
    { id: 'output', z: 'stand', type: 'http response', statusCode: '', headers: {}, wires: [] },
  ];
  return flow.map(item => item.type === 'tab' ? item : { x: 120, y: 100, ...item });
}

async function seed(db) {
  const collections = [
    ['subscription_provider_mappings', SUBSCRIPTION_RUNTIME_REQUIRED_INDEXES.mappings],
    ['subscription_policy_publications', SUBSCRIPTION_RUNTIME_REQUIRED_INDEXES.publications],
    ['subscription_projection_fences', SUBSCRIPTION_RUNTIME_REQUIRED_INDEXES.projectionFences],
  ];
  for (const [name, indexes] of collections) {
    for (const { key, ...options } of indexes) await db.collection(name).createIndex(key, options);
  }
  const { mapping, publications: [publication] } = bindingFixture();
  const rule = publication.runtimeProjection.benefitRules.find(item => item.category === 'GROUP_TRAINING');
  rule.externalEventTypeIds = [externalEventTypeId];
  publication.policyDigest = computeSubscriptionRuntimeProjectionDigest(publication.runtimeProjection);
  const fence = buildSubscriptionProjectionFence({ mapping, publication, previous: null });
  await db.collection(collections[0][0]).replaceOne({ mappingId: mapping.mappingId }, mapping, { upsert: true });
  await db.collection(collections[1][0]).replaceOne({ publicationId: publication.publicationId }, publication, { upsert: true });
  await db.collection(collections[2][0]).replaceOne({ mappingId: fence.mappingId }, fence, { upsert: true });
  return { publicationId: publication.publicationId, policyVersion: publication.policyVersion, policyDigest: publication.policyDigest, rule };
}

async function main() {
  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 12000 });
  const db = mongo.db(dbName);
  const policy = await seed(db);
  const repository = new ResidencyObservationRepository();
  const identity = new SubscriptionRuntimeContextService({
    verifyTrustedBearer: async auth => {
      const player = actors.get(auth);
      if (!player) throw new UnauthorizedException();
      return { actor: { tenantKey: actor.tenantId, clientId: player.clientId } };
    },
  }, {});
  const policyService = new ResidencyPurchasePolicyService(identity, repository);
  const services = new Map([[SubscriptionRuntimeContextService, identity], [ResidencyPurchasePolicyService, policyService]]);
  const types = Reflect.getMetadata('design:paramtypes', SubscriptionTrustedShadowController);
  class FixtureModule {}
  Module({
    controllers: [SubscriptionTrustedShadowController],
    providers: types.map(provide => ({ provide, useValue: services.get(provide) ?? {} })),
  })(FixtureModule);
  const cupApp = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
  cupApp.setGlobalPrefix('api');
  cupApp.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await cupApp.listen(Number(cupPort), '127.0.0.1');

  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(userDir, 'flows.json'), JSON.stringify(await previewFlow()), { mode: 0o600 });
  const app = express();
  const server = http.createServer(app);
  app.use(quotePath, (req, res, next) => {
    const key = req.headers['x-stand-trace'];
    if (key && typeof key === 'string' && key.length <= 80 && traces.size < 128) traces.set(key, []);
    next();
  });
  app.get('/__stand/info', (_req, res) => res.json({ lkOrigin, cupOrigin, target, policy }));
  app.get('/__stand/trace/:id', (req, res) => {
    const trace = traces.get(req.params.id);
    traces.delete(req.params.id);
    res.json(trace ?? null);
  });
  RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: false, httpNodeRoot: '/',
    credentialSecret: false, externalModules: { palette: { denyList: ['*'] } },
    functionGlobalContext: { ...settings, dispatchStandRead: dispatch }, logging: { console: { level: 'warn' } } });
  app.use('/', RED.httpNode);
  await RED.start();
  await new Promise((resolve, reject) => server.once('error', reject).listen(Number(lkPort), '127.0.0.1', resolve));
  console.log(JSON.stringify({ event: 'STAND_READY', lkOrigin, cupOrigin, target, policy }));
  async function stop() {
    await RED.stop();
    await new Promise(resolve => server.close(resolve));
    await cupApp.close();
    await repository.onModuleDestroy();
    await mongo.close();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop().catch(error => {
    console.error(error);
    process.exit(1);
  }));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

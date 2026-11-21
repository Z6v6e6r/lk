'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const checkoutPath = '/__stand/residency-checkout';
const adapterPath = '/__stand/provider-orders';
const safeReference = /^[a-f0-9]{64}$/;
const writeConcern = { writeConcern: { w: 'majority' } };

function installCheckout({ app, db, origin, quotePath, actors, tenantId, createCompositeResidencyCheckout }) {
  const journal = db.collection('composite_residency_orders');
  const orders = db.collection('fixture_provider_orders');
  const adapterToken = randomUUID();
  const counts = new Map();

  function count(reference, key) {
    const tally = counts.get(reference) ?? { createCalls: 0, lookupCalls: 0, droppedResponses: 0 };
    tally[key] += 1;
    counts.set(reference, tally);
  }

  function isAdapterRequest(req, res, next) {
    if (req.get('x-stand-adapter') !== adapterToken) return res.sendStatus(404);
    next();
  }

  app.post(adapterPath, isAdapterRequest, async (req, res, next) => {
    const { reference } = req.body ?? {};
    if (typeof reference !== 'string' || !safeReference.test(reference)) return res.sendStatus(400);
    try {
      count(reference, 'createCalls');
      // The provider sees an order only after the journal has agreed and persisted the two-line price.
      const pending = await journal.findOne({ _id: reference, state: 'SUBMITTING' });
      assert.equal(pending?.quote.totalMinor, req.body.totalMinor);
      assert.equal(pending?.exerciseId, req.body.exerciseId);
      assert.equal(pending?.clientId, req.body.clientId);
      const receipt = { ...req.body, providerOrderId: 'fixture-order-' + randomUUID() };
      // Deliberately use a fresh independent ID on every create. An erroneous
      // second create therefore produces a second order rather than hiding it.
      await orders.insertOne(receipt, writeConcern);
      count(reference, 'droppedResponses');
      res.socket.destroy();
    } catch (error) {
      next(error);
    }
  });

  app.get(adapterPath + '/:reference', isAdapterRequest, async (req, res, next) => {
    try {
      const { reference } = req.params;
      if (!safeReference.test(reference)) return res.sendStatus(400);
      count(reference, 'lookupCalls');
      const matches = await orders.find({ reference }, { projection: { _id: 0 } }).limit(2).toArray();
      if (matches.length !== 1) return res.sendStatus(matches.length === 0 ? 404 : 409);
      res.json(matches[0]);
    } catch (error) {
      next(error);
    }
  });

  const adapterHeaders = { 'x-stand-adapter': adapterToken, 'content-type': 'application/json' };
  const provider = {
    async create(request) {
      const reply = await fetch(origin + adapterPath, {
        method: 'POST', headers: adapterHeaders, body: JSON.stringify(request),
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!reply.ok) throw new Error('STAND_PROVIDER_CREATE_FAILED');
      return reply.json();
    },
    async lookup({ reference }) {
      const reply = await fetch(origin + adapterPath + '/' + encodeURIComponent(reference), {
        headers: adapterHeaders, redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      return reply.ok ? reply.json() : null;
    },
  };

  const authByClientId = new Map([...actors].map(([authorization, player]) => [player.clientId, authorization]));
  const checkout = createCompositeResidencyCheckout({
    collection: journal, provider,
    async readQuote(actor, exerciseId) {
      assert.equal(actor.tenantId, tenantId);
      const authorization = authByClientId.get(actor.clientId);
      assert(authorization);
      const reply = await fetch(origin + quotePath, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ target: { targetKind: 'GROUP_TRAINING_RESIDENCY_PURCHASE', exerciseId } }),
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
      const body = await reply.json();
      if (!reply.ok) throw Object.assign(new Error(body.error.code), { code: body.error.code, status: reply.status });
      return body;
    },
  });

  function fixtureActor(req, res, next) {
    const player = actors.get(req.get('authorization'));
    if (!player) return res.status(401).json({ error: { code: 'STAND_ACTOR_REQUIRED' } });
    req.fixtureActor = { tenantId, clientId: player.clientId };
    next();
  }

  app.post(checkoutPath, fixtureActor, async (req, res, next) => {
    try {
      const order = await checkout.checkout(req.fixtureActor, req.body ?? {});
      res.status(order.state === 'PENDING_CONFIRMATION' ? 202 : 200).json(order);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: { code: error.code } });
      if (['COMPOSITE_OPERATION_CONFLICT', 'COMPOSITE_QUOTE_CHANGED'].includes(error.code)) {
        return res.status(409).json({ error: { code: error.code } });
      }
      if (['COMPOSITE_EXERCISE_INVALID', 'COMPOSITE_OPERATION_INVALID', 'CONSENT_REQUIRED'].includes(error.code)) {
        return res.status(400).json({ error: { code: error.code } });
      }
      next(error);
    }
  });

  app.get(checkoutPath + '/:operationId/evidence', fixtureActor, async (req, res, next) => {
    try {
      const filter = { ...req.fixtureActor, operationId: req.params.operationId };
      const entry = await journal.findOne(filter);
      const providerOrders = entry ? await orders.find({ reference: entry._id }, {
        projection: { _id: 0, tenantId: 0, clientId: 0 },
      }).toArray() : [];
      const counters = entry ? counts.get(entry._id) : null;
      res.json({
        journalRows: await journal.countDocuments(filter),
        persistedState: entry?.state ?? null,
        providerOrderCount: providerOrders.length,
        createCalls: counters?.createCalls ?? 0,
        droppedResponses: counters?.droppedResponses ?? 0,
        lookupCalls: counters?.lookupCalls ?? 0,
        providerOrders,
      });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { checkoutPath, installCheckout };

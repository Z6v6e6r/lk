import { createHash } from 'node:crypto';
import { buildExactGraphContract, validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

// Injected verbatim into the Function node. No payload/details, identifiers or
// inbound diagnostic context are accepted by this diagnostic boundary.
export function subscriptionRouterBackgroundDiagnostic(step, status, error, getCrypto) {
  const steps = [
    'managed_sale_readiness', 'token_purchase', 'load_products', 'preview_promo',
    'create_transaction', 'token_confirm', 'confirm_recovery_list', 'confirm_lookup',
    'schema3_hub_instance_discovery', 'managed_sale_instance_readback', 'managed_sale_binding_confirm',
  ];
  const errors = new Map([
    ['Summer subscription context is missing', 'CONTEXT_MISSING'],
    ['Продажа подписки временно закрыта', 'SUBSCRIPTION_ADMISSION_CLOSED'],
    ['Новые продажи ХАБ не включены в этот выпуск', 'HUB_NEW_SALES_RELEASE_DISABLED'],
    ['Контур managed-продажи ХАБ не готов', 'MANAGED_SALE_READINESS_UNAVAILABLE'],
    ['Сервисная авторизация Viva не настроена', 'VIVA_SERVICE_AUTH_NOT_CONFIGURED'],
    ['Viva token error', 'VIVA_TOKEN_ERROR'],
    ['Failed to load Viva subscriptions', 'VIVA_SUBSCRIPTIONS_LOAD_FAILED'],
    ['Viva returned no subscriptions', 'VIVA_SUBSCRIPTIONS_EMPTY'],
    ['Цена Viva-продукта не соответствует ценовой партии', 'VIVA_PRODUCT_PRICE_MISMATCH'],
    ['Параметры активации Viva-продукта не соответствуют годовому предложению', 'VIVA_PRODUCT_ACTIVATION_MISMATCH'],
    ['Предложение изменилось. Примените промокод снова.', 'PROMO_OFFER_CHANGED'],
    ['Продажи этого периода закрыты', 'COUNTER_EPOCH_ADMISSION_CLOSED'],
    ['Стоимость изменилась или промокод не подтверждён. Примените его снова.', 'PROMO_NOT_CONFIRMED'],
    ['Результат покупки не подтверждён. Проверьте личный кабинет перед повторной оплатой.', 'PURCHASE_RESULT_UNCONFIRMED'],
    ['Failed to create Viva transaction', 'VIVA_TRANSACTION_CREATE_FAILED'],
    ['Viva вернула неверную сумму к оплате', 'VIVA_TRANSACTION_AMOUNT_MISMATCH'],
    ['Viva transaction has no paymentUrl', 'VIVA_TRANSACTION_PAYMENT_URL_MISSING'],
    ['Транзакция Viva требует ручной сверки', 'VIVA_TRANSACTION_MANUAL_RECONCILIATION_REQUIRED'],
    ['Не удалось проверить транзакции Viva по клиенту', 'VIVA_TRANSACTIONS_READ_FAILED'],
    ['Список транзакций Viva требует постраничной сверки', 'VIVA_TRANSACTIONS_PAGINATION_INCOMPLETE'],
    ['Транзакция Viva не определена однозначно', 'VIVA_TRANSACTION_AMBIGUOUS'],
    ['Экземпляр подписки Viva требует сверки', 'VIVA_SUBSCRIPTION_RECONCILIATION_REQUIRED'],
    ['Failed to fetch Viva transaction', 'VIVA_TRANSACTION_FETCH_FAILED'],
    ['Транзакция Viva не прошла повторную проверку', 'VIVA_TRANSACTION_RECHECK_FAILED'],
    ['Подтверждение Viva требует сверки; состояние покупки не изменено', 'VIVA_CONFIRMATION_RECONCILIATION_REQUIRED'],
    ['Unsupported summer subscription step', 'UNSUPPORTED_STEP'],
  ]);
  const event = {
    event: 'subscription_router_background_failed',
    code: 'SUBSCRIPTION_ROUTER_BACKGROUND_FAILED',
    statusCode: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    step: typeof step === 'string' && steps.includes(step) ? step : 'UNKNOWN',
    originalError: typeof error === 'string' ? errors.get(error) || 'UNKNOWN' : 'UNKNOWN',
    correlationHash: null,
    correlationScope: 'WARNING_EVENT',
  };
  try {
    const crypto = getCrypto();
    // A fresh server nonce, never a payment/client ID, _msgid, header, raw error
    // or pre-existing "hash". No key provisioning or persistent state required.
    const nonce = crypto.randomUUID();
    if (typeof nonce === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce)) {
      const digest = crypto.createHash('sha256').update(`lk-subscription-router-warning-v1\0${nonce}`).digest('hex');
      if (typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) event.correlationHash = `c1:${digest}`;
    }
  } catch { /* Crypto unavailable: retain safe enums with a null correlation. */ }
  return event;
}

export const ROUTER_SOURCE_SHA256 = '9be6be1d289e2b2d489776aae3b5cc6f7c6a2b00302523fa56ba3e09660c4316';
export const diagnosticRuntimeSource = `// BEGIN generated subscriptionRouterBackgroundDiagnostic\n${subscriptionRouterBackgroundDiagnostic.toString()}\n// END generated subscriptionRouterBackgroundDiagnostic\n\n`;
const failAnchor = 'const fail = (status, error, details) => {';
const oldWarning = `    if (typeof node !== "undefined" && typeof node.warn === "function") {
      node.warn(JSON.stringify({ event: "subscription_router_background_failed",
        code: "SUBSCRIPTION_ROUTER_BACKGROUND_FAILED", statusCode: status }));
    }`;
const newWarning = `    try {
      if (typeof node !== "undefined" && typeof node.warn === "function") {
        node.warn(JSON.stringify(subscriptionRouterBackgroundDiagnostic(
          msg._summerSubscriptionCtx?.step, status, error, () => global.get("crypto"))));
      }
    } catch { /* Diagnostics must not change the failure response or routing. */ }`;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function patchSubscriptionRouterDiagnosticSource(source) {
  if (typeof source !== 'string' || source.includes('// BEGIN generated subscriptionRouterBackgroundDiagnostic')
    || source.split(failAnchor).length !== 2 || source.split(oldWarning).length !== 2) {
    throw new Error('Subscription router diagnostic anchor drift');
  }
  const candidate = source.replace(failAnchor, diagnosticRuntimeSource + failAnchor).replace(oldWarning, newWarning);
  try { new Function('msg', 'node', 'global', candidate); }
  catch { throw new Error('Subscription router diagnostic syntax invalid'); }
  return candidate;
}

// Offline candidate composition only. Never substitutes the canonical file for
// the longer deployed router, and never changes wiring, other functions or data.
export function composeSubscriptionRouterDiagnosticCandidate(bytes, expectedFlowSha256, { expectedFunctionSha256 = ROUTER_SOURCE_SHA256 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedFlowSha256) || sha256(bytes) !== expectedFlowSha256) throw new Error('Flow preimage drift');
  let flow;
  try { flow = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid flow JSON'); }
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string' || !n.id)
    || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('Invalid flow identity');
  const active = flow.filter(n => n.type === 'function' && n.name === 'Route tournament subscription payment'
    && n.d !== true && n.disabled !== true
    && flow.some(tab => tab.id === n.z && tab.type === 'tab' && tab.disabled !== true));
  if (active.length !== 1 || typeof active[0].func !== 'string'
    || sha256(active[0].func) !== expectedFunctionSha256) throw new Error('Router source preimage drift');
  const target = active[0];
  const candidate = structuredClone(flow);
  candidate.find(n => n.id === target.id).func = patchSubscriptionRouterDiagnosticSource(target.func);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: 'subscription-router-background-diagnostic',
    allowedChanges: [{ id: target.id, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { candidateBytes, contract, report: { event: 'subscription_router_background_diagnostic_candidate',
    sourceSha256: sha256(bytes), candidateSha256: sha256(candidateBytes),
    beforeFunctionSha256: sha256(target.func), afterFunctionSha256: sha256(candidate.find(n => n.id === target.id).func),
    changedNodeCount: 1, changedFieldCount: 1, topologyUnchanged: true } };
}

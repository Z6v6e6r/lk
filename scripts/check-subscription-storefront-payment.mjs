/**
 * Headless CDP check for the storefront direct-payment flow.
 *
 * Starts its own headless Chrome with a temporary profile, drives the local
 * preview harness (scripts/preview-subscription-storefront.mjs) and asserts that
 * clicking "Оформить подписку" creates the payment in the widget and lands on the
 * bank URL from the stubbed purchase response.
 *
 *   node scripts/check-subscription-storefront-payment.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const previewUrl = process.env.PREVIEW_URL || 'http://127.0.0.1:5194';
const profileDir = mkdtempSync(join(tmpdir(), 'storefront-cdp-'));
const debuggingPort = 9333;

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${debuggingPort}`,
  'about:blank',
], { stdio: 'ignore' });

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await delay(250);
  }
  throw new Error('Chrome DevTools endpoint did not become available');
}

function createCdpClient(socket) {
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  return function send(method, params = {}) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(send, expression, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(send, expression);
    if (value) return value;
    await delay(400);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

const failures = [];

/**
 * A failing catalogue refresh must stay silent: no error copy and no retry
 * button, because the widget retries on its own every 30 seconds.
 */
const checkSilentStatusFailure = async (send, query) => {
  await send('Page.navigate', { url: `${previewUrl}/?${query}` });
  await waitFor(send, "document.querySelector('#padlhub-subscriptions') !== null");
  const readState = async () => JSON.parse(await evaluate(send, `(() => {
    const root = document.getElementById('padlhub-subscriptions');
    const text = root ? root.textContent : '';
    return JSON.stringify({
      hasErrorCopy: /Не удалось обновить подписки/.test(text),
      hasRetryButton: Array.prototype.some.call(root ? root.querySelectorAll('button') : [], (node) => node.textContent.trim() === 'Повторить'),
      alerts: root ? root.querySelectorAll('[role="alert"]').length : 0,
      loadingCopy: /Загружаем подписки/.test(text),
      noticeText: root && root.querySelector('.subscription-status-message')
        ? root.querySelector('.subscription-status-message').textContent.trim() : null,
      statusCalls: /stub status FAIL 500/.test(document.getElementById('preview-log')?.textContent || ''),
    });
  })()`));
  // The request layer retries before it gives up: wait until the stub was hit
  // and the widget settled into its final (silent) state.
  let state = await readState();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (state.statusCalls && !state.loadingCopy && !state.hasErrorCopy) break;
    await delay(1000);
    state = await readState();
  }
  if (!state.statusCalls) failures.push(`[${query}] the stubbed status endpoint was never called`);
  if (state.hasErrorCopy) failures.push(`[${query}] the storefront still prints the refresh error`);
  if (state.hasRetryButton) failures.push(`[${query}] the storefront still offers a retry button`);
  if (state.alerts) failures.push(`[${query}] the widget rendered ${state.alerts} alert region(s)`);
  if (state.loadingCopy) failures.push(`[${query}] the storefront stayed on the loading notice`);
  return state;
};

try {
  const wsUrl = await findTarget();
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const send = createCdpClient(socket);
  await send('Page.enable');
  await send('Runtime.enable');

  /** Waits for the stubbed purchase, the stored ref and the bank redirect. */
  const assertPurchaseReachedBank = async (query, expectedCounterKey) => {
    // The purchase request and the redirect happen in the same tick, so capture
    // the stub log before the bank page replaces the document.
    const log = await waitFor(
      send,
      "document.getElementById('preview-log') && /stub purchase/.test(document.getElementById('preview-log').textContent) ? document.getElementById('preview-log').textContent : ''",
      20_000,
    );
    const pending = await evaluate(send, "window.localStorage.getItem('padlhub_tournament_subscription_pending_refs') || ''");
    await waitFor(send, "document.location.href.indexOf('/mock-bank') !== -1");
    const bank = await evaluate(send, "document.getElementById('mock-bank')?.textContent || ''");
    if (!/stub purchase/.test(log)) failures.push(`[${query}] purchase endpoint was not called: ${log}`);
    if (!new RegExp(`"counterKey":"${expectedCounterKey}"`).test(log) || !/"planType":"friendship"/.test(log)) {
      failures.push(`[${query}] purchase payload lost the ${expectedCounterKey} counter binding: ${log}`);
    }
    if (!new RegExp(`"paymentRef":"${expectedCounterKey}-summer-`).test(pending)) {
      failures.push(`[${query}] pending payment was not stored for the bank return: ${pending}`);
    }
    if (!/MOCK BANK/.test(bank)) failures.push(`[${query}] bank page not reached`);
    return {
      log: log.replace(/\s+/g, ' ').trim().slice(-220),
      pendingRefs: pending.slice(0, 160) || '(none)',
      bank: bank.trim(),
    };
  };

  const clickFriendshipCta = async (query) => {
    const result = await evaluate(send, `(() => {
      const card = document.querySelector('[data-plan-id="friendship"]');
      if (!card) return 'card-missing';
      const cta = Array.prototype.find.call(
        card.querySelectorAll('button'),
        (button) => button.textContent.trim() === 'Оформить подписку',
      );
      if (!cta) return 'cta-missing';
      cta.click();
      return 'clicked';
    })()`);
    if (result !== 'clicked') failures.push(`[${query}] friendship CTA not clickable: ${result}`);
  };

  const runScenario = async (query) => {
    const annual = query.includes('plan=annual');
    await send('Page.navigate', { url: `${previewUrl}/?${query}` });
    await waitFor(send, "document.querySelectorAll('#padlhub-subscriptions [data-plan-id]').length > 0");

    // The annual terms row belongs to the checkout step, never to the page itself.
    const termsBeforeCta = await evaluate(send, "document.querySelectorAll('.subscription-consent').length");
    if (termsBeforeCta !== 0) failures.push(`[${query}] terms row rendered before the CTA press: ${termsBeforeCta}`);

    if (annual) {
      const selected = await evaluate(send, `(() => {
        const card = document.querySelector('[data-plan-id="friendship"]');
        const option = card && Array.prototype.find.call(
          card.querySelectorAll('[role="radio"]'),
          (node) => node.textContent.trim() === 'год',
        );
        if (!option) return 'option-missing';
        option.click();
        return 'selected';
      })()`);
      if (selected !== 'selected') failures.push(`[${query}] annual billing option is not selectable: ${selected}`);
    }

    await clickFriendshipCta(query);

    if (query.includes('auth=0')) {
      const overlay = await waitFor(
        send,
        "document.querySelector('.subscription-auth-block') ? document.querySelector('.subscription-auth-block').textContent : ''",
      );
      if (!/Войдите, чтобы продолжить оплату/.test(overlay)) failures.push(`[${query}] overlay caption missing: ${overlay}`);
      const form = await evaluate(send, `(() => {
        const card = document.querySelector('.subscription-auth-block .auth-card');
        if (!card) return 'auth-card-missing';
        const wrapper = document.querySelector('.subscription-auth-block .auth-wrapper');
        const styles = wrapper ? getComputedStyle(wrapper) : null;
        if (!styles || styles.display !== 'flex') return 'auth-styles-missing';
        return card.textContent.replace(new RegExp('\\s+', 'g'), ' ').trim().slice(0, 120);
      })()`);
      if (!/войти в личный кабинет|Войти или зарегистрироваться|Вход по SMS/i.test(form)) {
        failures.push(`[${query}] cabinet AuthForm not rendered: ${form}`);
      }
      return { overlay: overlay.replace(/\s+/g, ' ').trim().slice(0, 120), form };
    }

    if (!annual) return assertPurchaseReachedBank(query, 'friendship');

    // Annual: the terms dialog opens on the CTA press and gates the payment.
    const dialog = await waitFor(
      send,
      "document.querySelector('.subscription-auth-block') ? document.querySelector('.subscription-auth-block').textContent : ''",
    );
    if (!/Оформление годовой подписки/.test(dialog)) failures.push(`[${query}] terms dialog missing: ${dialog}`);
    if (!/условиями годовой подписки/.test(dialog)) failures.push(`[${query}] terms copy missing: ${dialog}`);

    const gate = JSON.parse(await evaluate(send, `(() => {
      const block = document.querySelector('.subscription-auth-block');
      const checkbox = block && block.querySelector('.subscription-consent input');
      const button = block && Array.prototype.find.call(block.querySelectorAll('.auth-btn'), () => true);
      return JSON.stringify({
        checkbox: Boolean(checkbox),
        continueDisabled: button ? button.disabled : null,
        purchaseCalled: /stub purchase/.test(document.getElementById('preview-log').textContent),
      });
    })()`));
    if (!gate.checkbox) failures.push(`[${query}] terms checkbox missing in the dialog`);
    if (gate.continueDisabled !== true) failures.push(`[${query}] continue button was usable before the terms were accepted`);
    if (gate.purchaseCalled) failures.push(`[${query}] payment was created before the terms were accepted`);

    const confirmed = await evaluate(send, `(() => {
      const block = document.querySelector('.subscription-auth-block');
      const checkbox = block && block.querySelector('.subscription-consent input');
      if (!checkbox) return 'checkbox-missing';
      checkbox.click();
      const button = block && Array.prototype.find.call(
        block.querySelectorAll('.auth-btn'),
        (node) => /Продолжить оплату/.test(node.textContent),
      );
      if (!button) return 'continue-missing';
      if (button.disabled) return 'continue-disabled';
      button.click();
      return 'continued';
    })()`);
    if (confirmed !== 'continued') failures.push(`[${query}] terms were not accepted: ${confirmed}`);

    const purchase = await assertPurchaseReachedBank(query, 'network_friendship');
    return { ...purchase, dialog: dialog.replace(/\s+/g, ' ').trim().slice(0, 120) };
  };

  const anonymous = await runScenario('auth=0');
  const authorized = await runScenario('auth=1');
  const annualTerms = await runScenario('auth=1&plan=annual');
  const silentFailure = await checkSilentStatusFailure(send, 'auth=1&fail=status');
  console.log(JSON.stringify({ anonymous, authorized, annualTerms, silentFailure, failures }, null, 2));
} catch (error) {
  failures.push(`harness error: ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify({ failures }, null, 2));
} finally {
  chrome.kill('SIGKILL');
  // Chrome may still hold handles in the temporary profile: cleanup is best effort.
  await delay(500);
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A leftover temp profile must not fail the check.
  }
}

if (failures.length > 0) {
  console.error('FAILED');
  process.exit(1);
}
console.log('PASS: storefront CTA creates the payment in the widget and redirects to the bank URL');

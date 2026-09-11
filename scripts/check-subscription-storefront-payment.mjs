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

  const runScenario = async (query) => {
    await send('Page.navigate', { url: `${previewUrl}/?${query}` });
    await waitFor(send, "document.querySelectorAll('#padlhub-subscriptions button').length > 0");

    const unauthCheck = await evaluate(send, `(() => {
      const buttons = Array.from(document.querySelectorAll('#padlhub-subscriptions button'));
      const cta = buttons.find(button => button.textContent.trim() === 'Оформить подписку');
      if (!cta) return 'cta-missing';
      cta.click();
      return 'clicked';
    })()`);
    if (unauthCheck !== 'clicked') failures.push(`[${query}] CTA not found`);

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
        return card.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
      })()`);
      if (!/войти в личный кабинет|Войти или зарегистрироваться|Вход по SMS/i.test(form)) {
        failures.push(`[${query}] cabinet AuthForm not rendered: ${form}`);
      }
      return { overlay: overlay.replace(/\s+/g, ' ').trim().slice(0, 120), form };
    }

    const consent = await evaluate(send, `(() => {
      const label = document.querySelector('.subscription-consent');
      if (!label) return 'consent-missing';
      const input = label.querySelector('input');
      input.click();
      return input.checked ? 'checked' : 'unchecked';
    })()`);
    if (consent !== 'checked') failures.push(`[${query}] consent checkbox not usable: ${consent}`);

    await send('Page.navigate', { url: `${previewUrl}/?auth=1` });
    await waitFor(send, "document.querySelectorAll('#padlhub-subscriptions button').length > 0");
    await evaluate(send, `(() => {
      const label = document.querySelector('.subscription-consent input');
      if (label && !label.checked) label.click();
      const cta = Array.from(document.querySelectorAll('#padlhub-subscriptions button'))
        .find(button => button.textContent.trim() === 'Оформить подписку');
      cta.click();
    })()`);

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
    if (!/"counterKey":"friendship"/.test(log) || !/"planType":"friendship"/.test(log)) {
      failures.push(`[${query}] purchase payload lost the friendship counter binding: ${log}`);
    }
    if (!/"paymentRef":"friendship-summer-/.test(pending)) {
      failures.push(`[${query}] pending payment was not stored for the bank return: ${pending}`);
    }
    if (!/MOCK BANK/.test(bank)) failures.push(`[${query}] bank page not reached`);
    return {
      log: log.replace(/\s+/g, ' ').trim().slice(-220),
      pendingRefs: pending.slice(0, 160) || '(none)',
      bank: bank.trim(),
    };
  };

  const anonymous = await runScenario('auth=0');
  const authorized = await runScenario('auth=1');
  console.log(JSON.stringify({ anonymous, authorized, failures }, null, 2));
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

export const PADLHUB_VIVA_USER_AGENT = "PadlHub-LK/1.0";

const VIVA_ROOT_HOST = "vivacrm.ru";

export function validateVivaUserAgent(value = PADLHUB_VIVA_USER_AGENT) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new Error("Viva User-Agent must contain 1-128 characters");
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) {
      throw new Error("Viva User-Agent must contain visible ASCII characters only");
    }
  }
  return value;
}

export function isVivaHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  return normalized === VIVA_ROOT_HOST || normalized.endsWith(`.${VIVA_ROOT_HOST}`);
}

export function isVivaUrl(input) {
  try {
    const raw = typeof Request !== "undefined" && input instanceof Request
      ? input.url
      : input;
    const url = raw instanceof URL ? raw : new URL(String(raw));
    return (url.protocol === "https:" || url.protocol === "http:")
      && isVivaHostname(url.hostname);
  } catch {
    return false;
  }
}

function requestHeaders(input) {
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.headers;
  }
  return undefined;
}

export function withVivaUserAgent(input, init = {}, userAgent = PADLHUB_VIVA_USER_AGENT) {
  if (!isVivaUrl(input)) return init;

  const validated = validateVivaUserAgent(userAgent);
  const headers = new Headers(requestHeaders(input));
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));

  const existing = headers.get("user-agent");
  if (existing && existing !== validated) {
    throw new Error(`Conflicting Viva User-Agent: ${existing}`);
  }
  headers.set("User-Agent", validated);
  return { ...init, headers };
}

export function createVivaFetch(
  fetchImplementation = globalThis.fetch,
  userAgent = PADLHUB_VIVA_USER_AGENT,
) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("Viva fetch implementation must be a function");
  }
  const validated = validateVivaUserAgent(userAgent);
  return (input, init) => fetchImplementation(
    input,
    withVivaUserAgent(input, init, validated),
  );
}

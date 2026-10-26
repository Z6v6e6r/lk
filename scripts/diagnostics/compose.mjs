import { createDiagnostics } from "./runtime.mjs";
// Returns a candidate settings object; never reads/writes the installed settings or starts Node-RED.
// Existing middleware executes once with unchanged next/error semantics.
export function composeDiagnosticSettings(base, options) {
  if (!base || typeof base !== "object" || Array.isArray(base)
    || base.functionGlobalContext?.lkDiagnostics || (base.httpNodeMiddleware && typeof base.httpNodeMiddleware !== "function")) {
    throw new Error("DIAGNOSTIC_SETTINGS_CONFLICT");
  }
  const diagnostics = createDiagnostics(options);
  const previous = base.httpNodeMiddleware;
  return { ...base, functionGlobalContext: { ...base.functionGlobalContext, lkDiagnostics: diagnostics },
    httpNodeMiddleware(req, res, next) {
      diagnostics.middleware(req, res, () => previous ? previous(req, res, next) : next());
    } };
}

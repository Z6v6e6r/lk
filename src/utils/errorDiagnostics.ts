import { routeTemplate, sanitizeEvent, UUID } from "./errorDiagnosticsCore.mjs";
export { routeTemplate };
let unavailable = 0;
export function diagnosticHealth() { return { unavailable }; }
export function diagnosticId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  unavailable++;
  throw new Error("DIAGNOSTIC_RANDOM_UNAVAILABLE");
}
export function callerBuild(): string {
  const build: unknown = import.meta.env.VITE_DIAGNOSTIC_BUILD;
  return typeof build === "string" && /^[0-9a-f]{40}$/.test(build) ? build : "UNKNOWN";
}
export function clientDiagnostic(context: Record<string, unknown> = {}): Record<string, unknown> | null {
  try {
    const requestId = typeof context.requestId === "string" && UUID.test(context.requestId) ? context.requestId : diagnosticId();
    return sanitizeEvent({ ...context, schemaVersion: 1, diagnosticEventId: diagnosticId(), requestId,
      eventKind: "client_error", source: "browser", deviceEventTime: context.deviceEventTime ?? new Date().toISOString(), deviceClockTrusted: false,
      callerBuild: callerBuild(), stage: context.stage ?? "global_error", code: context.code ?? "CLIENT_RUNTIME_ERROR" });
  } catch { return null; }
}
export function abortCause(signal?: AbortSignal | null): "deadline" | "scope_disposed" | "explicit_cancel" | "unknown" {
  if (!signal?.aborted) return "unknown";
  return ["deadline", "scope_disposed", "explicit_cancel"].includes(signal.reason) ? signal.reason : "unknown";
}

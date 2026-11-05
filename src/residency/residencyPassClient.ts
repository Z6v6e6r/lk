import {
  isResidentPassPayload,
  isResidentPassStatusPayload,
  type ResidentPass,
  type ResidentPassStatus,
  type ResidencyFailure,
} from "./residencyPassModel.ts";

export interface ResidencyTransportRequest {
  method: "POST" | "GET";
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

export interface ResidencyTransportResult {
  status: number | null;
  data: unknown;
  networkError: boolean;
}

export type ResidencyTransport = (
  request: ResidencyTransportRequest,
) => Promise<ResidencyTransportResult>;

export type ResidencyPassResult<T> = { ok: true; value: T } | { ok: false; failure: ResidencyFailure };

function readErrorCode(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  if (typeof record.code === "string" && record.code.trim()) return record.code.trim();
  return null;
}

function fallbackCodeForStatus(status: number | null): string {
  if (status === 401) return "RESIDENT_CLIENT_AUTH_REQUIRED";
  if (status === 403) return "RESIDENT_CLIENT_FORBIDDEN";
  if (status === 404) return "RESIDENT_PASS_NOT_FOUND";
  if (status === 409) return "RESIDENT_CLIENT_SUBSCRIPTION_INVALID";
  if (status === 429) return "RESIDENT_CLIENT_RATE_LIMITED";
  if (status === 504) return "RESIDENT_CLIENT_UPSTREAM_TIMEOUT";
  if (typeof status === "number" && status >= 500) return "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE";
  return "RESIDENT_CLIENT_REQUEST_INVALID";
}

function toFailure(result: ResidencyTransportResult): ResidencyFailure {
  return {
    code: readErrorCode(result.data) || fallbackCodeForStatus(result.status),
    status: result.status,
    networkError: result.networkError,
  };
}

function toInvalidPayloadFailure(result: ResidencyTransportResult): ResidencyFailure {
  return {
    code: result.networkError ? "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE" : "RESIDENT_CLIENT_UPSTREAM_INVALID",
    status: result.status,
    networkError: result.networkError,
  };
}

function isSuccessfulStatus(status: number | null): boolean {
  return typeof status === "number" && status >= 200 && status < 300;
}

export function createResidencyPassClient(transport: ResidencyTransport) {
  return {
    async createPass(clientSubscriptionId: string, signal?: AbortSignal): Promise<ResidencyPassResult<ResidentPass>> {
      const result = await transport({
        method: "POST",
        path: "/lk/residency/passes",
        body: { clientSubscriptionId },
        signal,
      });
      if (result.networkError) {
        return { ok: false, failure: { code: "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE", status: null, networkError: true } };
      }
      if (!isSuccessfulStatus(result.status)) {
        return { ok: false, failure: toFailure(result) };
      }
      if (!isResidentPassPayload(result.data)) {
        return { ok: false, failure: toInvalidPayloadFailure(result) };
      }
      return { ok: true, value: result.data };
    },

    async fetchStatus(passId: string, signal?: AbortSignal): Promise<ResidencyPassResult<ResidentPassStatus>> {
      const result = await transport({
        method: "GET",
        path: `/lk/residency/passes/${encodeURIComponent(passId)}`,
        signal,
      });
      if (result.networkError) {
        return { ok: false, failure: { code: "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE", status: null, networkError: true } };
      }
      if (!isSuccessfulStatus(result.status)) {
        return { ok: false, failure: toFailure(result) };
      }
      if (!isResidentPassStatusPayload(result.data)) {
        return { ok: false, failure: toInvalidPayloadFailure(result) };
      }
      return { ok: true, value: result.data };
    },
  };
}

export type ResidencyPassClient = ReturnType<typeof createResidencyPassClient>;

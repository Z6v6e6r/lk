import { AUTH_RUNTIME_TENANT_KEY } from "./authRuntime.ts";
import { ACADEMY_TENANT_CONTRACT } from "../services/academyTenantContract.ts";

export const IS_PRIMARY_TENANT = AUTH_RUNTIME_TENANT_KEY === "iSkq6G";
export const IS_ACADEMY_TENANT = AUTH_RUNTIME_TENANT_KEY === ACADEMY_TENANT_CONTRACT.tenantKey;

export function academyEndpoint(path: string): string {
  if (!IS_ACADEMY_TENANT) throw new Error("Academy integration is not configured for this tenant");
  const configured = String(import.meta.env?.VITE_ACADEMY_BACKEND_BASE || "").trim();
  if (!configured) throw new Error("VITE_ACADEMY_BACKEND_BASE is required for tenant 005JDA");
  const base = new URL(configured);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash
    || base.pathname.replace(/\/+$/, "") !== ACADEMY_TENANT_CONTRACT.namespace) {
    throw new Error("Invalid academy backend URL");
  }
  if (!/^[a-z-]+(?:\/[a-z-]+)?$/.test(path)) throw new Error("Invalid academy endpoint");
  return `${base.origin}${ACADEMY_TENANT_CONTRACT.namespace}/${path}`;
}

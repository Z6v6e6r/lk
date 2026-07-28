type ImportMetaEnvLike = {
  VITE_KEYCLOAK_BASE?: string;
  VITE_TENANT_KEY?: string;
  VITE_CABINET_URL?: string;
};

function readEnv(): ImportMetaEnvLike {
  try {
    const env = (import.meta as ImportMeta & { env?: ImportMetaEnvLike }).env;
    return env ?? {};
  } catch {
    return {};
  }
}

const env = readEnv();

export const AUTH_RUNTIME_KEYCLOAK_BASE =
  String(env.VITE_KEYCLOAK_BASE || "").trim() || "https://kc.vivacrm.ru";
export const AUTH_RUNTIME_TENANT_KEY =
  String(env.VITE_TENANT_KEY || "").trim() || "iSkq6G";
export const AUTH_RUNTIME_CABINET_URL =
  String(env.VITE_CABINET_URL || "").trim() || "https://padlhub.ru/lk_new";

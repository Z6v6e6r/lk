const LOCAL_PAGE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRODUCTION_LK_API_HOSTS = new Set(["padlhub.su", "www.padlhub.su", "padlhub.ru", "www.padlhub.ru"]);

export type TournamentHistoryRequestPolicyInput = {
  pageUrl: string | null | undefined;
  apiUrl: string | null | undefined;
  allowLocalProductionApi: boolean;
};

function parseUrl(value: string | null | undefined): URL | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

export function shouldBlockLocalProductionTournamentHistoryRequest(
  input: TournamentHistoryRequestPolicyInput,
): boolean {
  if (input.allowLocalProductionApi) return false;

  const pageUrl = parseUrl(input.pageUrl);
  const apiUrl = parseUrl(input.apiUrl);
  if (!pageUrl || !apiUrl) return false;

  const pageHost = pageUrl.hostname.toLowerCase();
  const apiHost = apiUrl.hostname.toLowerCase();
  return LOCAL_PAGE_HOSTS.has(pageHost) && PRODUCTION_LK_API_HOSTS.has(apiHost);
}

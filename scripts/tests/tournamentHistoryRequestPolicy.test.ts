import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shouldBlockLocalProductionTournamentHistoryRequest } from "../../src/utils/tournamentHistoryRequestPolicy.ts";

const apiClientSource = readFileSync(
  fileURLToPath(new URL("../../src/utils/apiClient.ts", import.meta.url)),
  "utf8",
);
const apiConfigSource = readFileSync(
  fileURLToPath(new URL("../../src/consts/api_config.tsx", import.meta.url)),
  "utf8",
);

test("blocks a localhost page from reading the production tournament history API", () => {
  assert.equal(shouldBlockLocalProductionTournamentHistoryRequest({
    pageUrl: "http://127.0.0.1:8765/?test=history",
    apiUrl: "https://padlhub.su/seliger",
    allowLocalProductionApi: false,
  }), true);
  assert.equal(shouldBlockLocalProductionTournamentHistoryRequest({
    pageUrl: "http://localhost:3036/lk_subscription_dev",
    apiUrl: "https://padlhub.ru/lk",
    allowLocalProductionApi: false,
  }), true);
});

test("allows local reserve API, production pages, and an explicit operator override", () => {
  assert.equal(shouldBlockLocalProductionTournamentHistoryRequest({
    pageUrl: "http://127.0.0.1:8765/",
    apiUrl: "https://lk-reserve.89-108-64-209.sslip.io/seliger",
    allowLocalProductionApi: false,
  }), false);
  assert.equal(shouldBlockLocalProductionTournamentHistoryRequest({
    pageUrl: "https://padlhub.ru/lk_new",
    apiUrl: "https://padlhub.su/seliger",
    allowLocalProductionApi: false,
  }), false);
  assert.equal(shouldBlockLocalProductionTournamentHistoryRequest({
    pageUrl: "http://127.0.0.1:8765/",
    apiUrl: "https://padlhub.su/seliger",
    allowLocalProductionApi: true,
  }), false);
});

test("fails open for non-browser or malformed diagnostic inputs", () => {
  assert.equal(shouldBlockLocalProductionTournamentHistoryRequest({
    pageUrl: null,
    apiUrl: "https://padlhub.su/seliger",
    allowLocalProductionApi: false,
  }), false);
  assert.equal(shouldBlockLocalProductionTournamentHistoryRequest({
    pageUrl: "not-a-url",
    apiUrl: "https://padlhub.su/seliger",
    allowLocalProductionApi: false,
  }), false);
});

test("api client enables the local production override only in a DEV release channel", () => {
  assert.match(
    apiConfigSource,
    /VITE_ALLOW_LOCAL_PRODUCTION_HISTORY_API/,
  );
  assert.match(
    apiClientSource,
    /allowLocalProductionApi:\s*IS_DEV_RELEASE_CHANNEL\s*&&\s*ALLOW_LOCAL_PRODUCTION_HISTORY_API/,
  );
});

// Source-generation pins.
//
// Every reviewed Node-RED generation records the exact source text it consumed.
// When a later focused generation changes one of those files, the older
// generation binding keeps its historical hashes untouched and the file becomes
// pinned by the newest generation that consumed it instead. Generations are
// listed newest first, and the first entry for a file wins.
import { HUB_LIMIT_TARGETS } from '../patch_live_subscription_hub_limit.mjs';
import { STATUS_PRICE_TARGETS } from '../patch_live_subscription_status_price.mjs';

const GENERATIONS_NEWEST_FIRST = [HUB_LIMIT_TARGETS, STATUS_PRICE_TARGETS];
const NEWEST_SOURCE_SHA256_BY_FILE = new Map();
for (const generation of GENERATIONS_NEWEST_FIRST) {
  for (const target of generation) {
    if (!NEWEST_SOURCE_SHA256_BY_FILE.has(target.fileName)) {
      NEWEST_SOURCE_SHA256_BY_FILE.set(target.fileName, target.candidateSha256);
    }
  }
}

export function newestReviewedSourceSha256(fileName) {
  return NEWEST_SOURCE_SHA256_BY_FILE.get(fileName) ?? null;
}

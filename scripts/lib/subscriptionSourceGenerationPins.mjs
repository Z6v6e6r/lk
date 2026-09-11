// Source-generation pins.
//
// Every reviewed Node-RED generation records the exact source text it consumed.
// When a later focused generation changes one of those files, the older
// generation binding keeps its historical hashes untouched and the file becomes
// pinned by the newest generation that consumed it instead. This module is the
// single place that answers "which generation owns this source file now".
import { STATUS_PRICE_TARGETS } from '../patch_live_subscription_status_price.mjs';

const NEWEST_SOURCE_SHA256_BY_FILE = new Map(
  STATUS_PRICE_TARGETS.map((target) => [target.fileName, target.candidateSha256]),
);

export function newestReviewedSourceSha256(fileName) {
  return NEWEST_SOURCE_SHA256_BY_FILE.get(fileName) ?? null;
}

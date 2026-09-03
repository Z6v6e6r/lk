import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateReleaseReceiptV2 } from "../validate_lk1_subscription_dev_release_receipt_v2.mjs";

const contract = () => JSON.parse(fs.readFileSync(
  new URL("../lk1_subscription_dev_release_receipt_v2_contract.json", import.meta.url), "utf8",
));

test("source-only receipt keeps host and served evidence null and all authority false", () => {
  const value = contract();
  assert.equal(validateReleaseReceiptV2(value), true);
  assert.throws(() => validateReleaseReceiptV2(value, { requireInstalled: true }), /state evidence/);
  assert.throws(() => validateReleaseReceiptV2(value, { requireServed: true }), /state evidence/);
});

test("receipt v2 distinguishes the 40-hex Git commit from 64-hex artifacts", () => {
  for (const mutate of [
    (value) => { value.sourceCommit = "a".repeat(64); },
    (value) => { value.sourceFlowSha256 = "a".repeat(40); },
    (value) => { value.candidateSha256 = "b".repeat(40); },
    (value) => { value.manifestSha256 = "c".repeat(40); },
    (value) => { value.hostReadbackSha256 = "d".repeat(64); },
    (value) => { value.servedSha256 = "e".repeat(64); },
    (value) => { value.authority.hostInstall = true; },
    (value) => { value.hostPreimage.state = "PRESENT"; },
    (value) => { value.rollback.deleteData = true; },
  ]) {
    const value = contract();
    mutate(value);
    assert.throws(() => validateReleaseReceiptV2(value));
  }
});

test("installed and served states require their own 64-hex evidence", () => {
  const installed = contract();
  installed.state = "INSTALLED_STOPPED";
  installed.hostReadbackSha256 = installed.candidateSha256;
  assert.equal(validateReleaseReceiptV2(installed, { requireInstalled: true }), true);
  const served = structuredClone(installed);
  served.state = "SERVED";
  served.servedSha256 = served.candidateSha256;
  assert.equal(validateReleaseReceiptV2(served, { requireServed: true }), true);
});

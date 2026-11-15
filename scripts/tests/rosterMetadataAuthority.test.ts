import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mergeRosterMetadata } from "../../src/components/games/rosterMetadata.ts";

const authorityKeys = ["organizerId", "organizerPhone", "organizerPhoneNorm"];
const organizer = { id: "organizer", phone: "70000000001" };
const guardSource = fs.readFileSync("scripts/nodered_organizer_handoff_nodes/fn_patch_authority_check.js", "utf8");
function guard(metadata: Record<string, unknown>, current: Record<string, unknown>, changes = {}) {
  const msg = {
    payload: [{ organizer, metadata: current, ...changes }],
    _organizerGuardBody: { organizer, participants: [{ id: "participant" }], metadata },
  };
  return new Function("msg", guardSource)(structuredClone(msg));
}

test("roster metadata without optional organizer aliases passes the unchanged server guard", () => {
  const current = { splitPayment: { enabled: true } };
  const metadata = mergeRosterMetadata(current, { bookingIds: ["existing-booking"] });
  for (const key of authorityKeys) assert.equal(Object.hasOwn(metadata, key), false);
  assert.ok(guard(metadata, current)[0]);
  assert.deepEqual(current, { splitPayment: { enabled: true } });
});

for (const value of [undefined, null, "", "stored-authority-value"]) {
  test(`stored authority presence and value survive additions (${String(value)})`, () => {
    const current = Object.fromEntries(authorityKeys.map(key => [key, value]));
    const metadata = mergeRosterMetadata(current, Object.fromEntries(authorityKeys.map(key => [key, "replacement"])));
    for (const key of authorityKeys) {
      assert.equal(Object.hasOwn(metadata, key), true);
      assert.equal(metadata[key], value);
    }
  });
}

test("extra metadata cannot introduce absent aliases or replace existing ones", () => {
  const additions = { organizerId: "attacker", organizerPhone: "70000000002", organizerPhoneNorm: "70000000002" };
  assert.deepEqual(mergeRosterMetadata({}, additions), {});
  const current = { organizerId: organizer.id, organizerPhone: organizer.phone, organizerPhoneNorm: organizer.phone };
  const metadata = mergeRosterMetadata(current, { ...additions, title: "Updated title" });
  assert.deepEqual(metadata, { ...current, title: "Updated title" });
  assert.ok(guard(metadata, current)[0]);
});

test("existing inconsistent aliases are preserved rather than silently reassigned", () => {
  const current = { organizerId: "stored-alias", organizerPhone: null };
  const metadata = mergeRosterMetadata(current, { organizerId: organizer.id, organizerPhone: organizer.phone });
  assert.deepEqual(metadata, current);
  assert.ok(guard(metadata, current)[0]);
});

test("server still refuses forged organizer, alias takeover and membership mutation", () => {
  const current = { organizerId: organizer.id, organizerPhone: organizer.phone, organizerPhoneNorm: organizer.phone };
  for (const key of authorityKeys) {
    const outputs = guard({ ...current, [key]: "attacker" }, current);
    assert.equal(outputs[0], null);
    assert.equal(outputs[1].statusCode, 409);
    assert.equal(outputs[1].payload.code, "ORGANIZER_COMMAND_REQUIRED");
  }
  const msg = { payload: [{ organizer, metadata: current }], _organizerGuardBody: {
    organizer: { ...organizer, id: "attacker" }, metadata: current,
  } };
  assert.equal(new Function("msg", guardSource)(msg)[1].statusCode, 409);
  assert.equal(guard(current, current, { membershipMutation: { operationKey: "other-operation" } })[1].statusCode, 409);
});

test("production roster builder uses the merge without reintroducing authority aliases", () => {
  const source = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  const builder = source.slice(source.indexOf("const buildDetailsRosterMetadata ="), source.indexOf("const cancelVivaBookingsForPlayerFromDetails ="));
  assert.match(builder, /return mergeRosterMetadata\(detailsMetadata,/);
  assert.doesNotMatch(builder, /organizer(?:Id|Phone|PhoneNorm):/);
});

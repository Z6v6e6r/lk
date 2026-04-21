const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toArray = (value) => (Array.isArray(value) ? value : []);

const ctx = isObj(msg._gameAutojoinPatch) ? msg._gameAutojoinPatch : {};
const existingRows = toArray(msg.payload).filter((item) => isObj(item));
const existing = existingRows[0] || null;
const patch = isObj(ctx.patch) ? ctx.patch : {};

if (!existing) {
  msg.payload = {
    ok: false,
    reason: "PATCH_GAME_NOT_FOUND",
    gameId: ctx.gameId || null,
  };
  return [null, msg];
}

const mergeNested = (currentValue, patchValue) => {
  if (isObj(currentValue) && isObj(patchValue)) {
    return Object.assign({}, currentValue, patchValue);
  }
  return patchValue === undefined ? currentValue : patchValue;
};

const merged = Object.assign({}, existing, patch);
merged.organizer = mergeNested(existing.organizer, patch.organizer);
merged.booking = mergeNested(existing.booking, patch.booking);
merged.payment = mergeNested(existing.payment, patch.payment);
merged.settings = mergeNested(existing.settings, patch.settings);
merged.invite = mergeNested(existing.invite, patch.invite);
merged.metadata = mergeNested(existing.metadata, patch.metadata);

msg.payload = merged;
msg._gameAutojoinSource = ctx.source || "games_patch";
return [msg, null];

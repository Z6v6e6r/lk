import crypto from "node:crypto";

const SLUG_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;
const TENANT_PATTERN = /^[A-Za-z0-9]{4,16}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const cloneNodeId = (slug, sourceId) =>
  crypto.createHash("sha1").update(`${slug}:${sourceId}`).digest("hex").slice(0, 16);

export function parseTenantProfile(raw) {
  if (!isObject(raw)) throw new Error("tenant profile must be an object");

  const slug = String(raw.slug || "").trim();
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`tenant profile slug must match ${SLUG_PATTERN}: got "${slug}"`);
  }

  const vivaTenant = String(raw.vivaTenant || "").trim();
  if (!TENANT_PATTERN.test(vivaTenant)) {
    throw new Error(`tenant profile vivaTenant must match ${TENANT_PATTERN}: got "${vivaTenant}"`);
  }

  const sourceVivaTenant = String(raw.sourceVivaTenant || "iSkq6G").trim();
  if (!TENANT_PATTERN.test(sourceVivaTenant)) {
    throw new Error(`tenant profile sourceVivaTenant must match ${TENANT_PATTERN}`);
  }

  const pathPrefix = String(raw.pathPrefix || "").trim();
  if (!/^\/[a-z0-9][a-z0-9-]*$/.test(pathPrefix)) {
    throw new Error(`tenant profile pathPrefix must look like "/pade-prime": got "${pathPrefix}"`);
  }

  const collectionPrefix = String(raw.collectionPrefix || "").trim();
  if (!/^[a-z][a-z0-9_]{1,15}_$/.test(collectionPrefix)) {
    throw new Error(
      `tenant profile collectionPrefix must look like "pp_" (lowercase, trailing underscore): got "${collectionPrefix}"`,
    );
  }

  const tabs = Array.isArray(raw.tabs) ? raw.tabs.map((item) => String(item).trim()).filter(Boolean) : [];
  if (!tabs.length) throw new Error("tenant profile must list at least one source tab label");

  const timezone = isObject(raw.timezone) ? raw.timezone : {};
  const offset = String(timezone.offset || "").trim();
  if (!/^[+-]\d{2}:\d{2}$/.test(offset)) {
    throw new Error(`tenant profile timezone.offset must look like "+07:00": got "${offset}"`);
  }
  const iana = String(timezone.iana || "").trim();
  if (!iana) throw new Error("tenant profile timezone.iana is required");

  const sourceOffset = String(timezone.sourceOffset || "+03:00").trim();
  const sourceIana = String(timezone.sourceIana || "Europe/Moscow").trim();

  const dropHttpIn = Array.isArray(raw.dropHttpIn)
    ? raw.dropHttpIn.map((item) => String(item).trim()).filter(Boolean)
    : [];
  for (const pattern of dropHttpIn) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`tenant profile dropHttpIn pattern is not a valid regex: ${pattern} (${error.message})`);
    }
  }

  const globalKeyMap = isObject(raw.globalKeyMap) ? raw.globalKeyMap : {};
  for (const [key, value] of Object.entries(globalKeyMap)) {
    if (!key.trim() || typeof value !== "string" || !value.trim()) {
      throw new Error(`tenant profile globalKeyMap entry is invalid: ${key}`);
    }
  }

  const vivaIds = isObject(raw.vivaIds) ? raw.vivaIds : {};

  const bodyReplacements = Array.isArray(raw.bodyReplacements)
    ? raw.bodyReplacements.map((item, index) => {
      if (!isObject(item)) throw new Error(`tenant profile bodyReplacements[${index}] must be an object`);
      const find = String(item.find || "");
      if (!find.trim()) throw new Error(`tenant profile bodyReplacements[${index}].find is required`);
      const replace = typeof item.replace === "string" ? item.replace : "";
      return Object.freeze({ find, replace, required: item.required !== false });
    })
    : [];

  const blockers = Array.isArray(raw.blockers)
    ? raw.blockers.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const reuseConfigNodeIds = Array.isArray(raw.reuseConfigNodeIds)
    ? raw.reuseConfigNodeIds.map((item) => String(item).trim()).filter(Boolean)
    : [];
  for (const id of reuseConfigNodeIds) {
    if (!/^[0-9a-f]{16}$/.test(id)) {
      throw new Error(`tenant profile reuseConfigNodeIds entry must be a 16-char hex node id: got "${id}"`);
    }
  }

  return Object.freeze({
    slug,
    displayName: String(raw.displayName || slug),
    sourceVivaTenant,
    vivaTenant,
    pathPrefix,
    collectionPrefix,
    sourceOffset,
    offset,
    sourceIana,
    iana,
    tabs: Object.freeze(tabs),
    dropHttpIn: Object.freeze(dropHttpIn),
    globalKeyMap: Object.freeze({ ...globalKeyMap }),
    vivaIds: Object.freeze({ ...vivaIds }),
    bodyReplacements: Object.freeze(bodyReplacements),
    blockers: Object.freeze(blockers),
    reuseConfigNodeIds: Object.freeze(reuseConfigNodeIds),
  });
}

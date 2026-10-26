import { sha } from "./source-hooks.mjs";
// Explicit candidate-only graph transform. Append observation branches; preserve all business wires.
export function addMaxObservers(flow, attestations) {
  const candidate = structuredClone(flow);
  const ids = new Set(candidate.map(n => n.id));
  for (const { id, hash, connector } of attestations) {
    const send = candidate.find(n => n.id === id);
    if (!send || send.type !== "maxbot-send" || sha(JSON.stringify(send)) !== hash
      || !["MAX_BOT", "MAX_ACADEMY_BOT"].includes(connector)) throw new Error("DIAGNOSTIC_MAX_SOURCE_DRIFT");
    const output = `diag_output_${id}`, caught = `diag_catch_${id}`, error = `diag_error_${id}`;
    if ([output, caught, error].some(key => ids.has(key))) throw new Error("DIAGNOSTIC_MAX_DUPLICATE");
    const wrap = statement => `try { global.get("lkDiagnostics")?.${statement}; } catch {}\nreturn null;`;
    candidate.push({ id: output, type: "function", z: send.z, name: "MAX diagnostic SDK output", outputs: 0, wires: [],
      func: wrap(`observe(msg, "max_sdk_result", { connector: msg.supportOutbox?.connector || "UNKNOWN", configuredConnector: ${JSON.stringify(connector)}, bindingEqual: msg.supportOutbox?.connector === ${JSON.stringify(connector)}, sdkOutputPresent: true, executionObserved: true, code: "UPSTREAM_OBSERVED", outcome: "outcome_unknown" })`) });
    candidate.push({ id: caught, type: "catch", z: send.z, name: "MAX diagnostic SDK exception", scope: [id], uncaught: false, wires: [[error]] });
    candidate.push({ id: error, type: "function", z: send.z, name: "MAX diagnostic exception observer", outputs: 0, wires: [],
      func: wrap(`transport(msg, "max_sdk_result", msg.error, false, { connector: msg.supportOutbox?.connector || "UNKNOWN", configuredConnector: ${JSON.stringify(connector)}, bindingEqual: msg.supportOutbox?.connector === ${JSON.stringify(connector)} })`) });
    if (!Array.isArray(send.wires) || !Array.isArray(send.wires[0])) throw new Error("DIAGNOSTIC_MAX_WIRING_UNKNOWN");
    send.wires[0].push(output);
    [output, caught, error].forEach(key => ids.add(key));
  }
  return candidate;
}

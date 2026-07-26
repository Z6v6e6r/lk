import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

function summarizeNode(node) {
  return {
    id: node.id,
    type: node.type,
    name: node.name || node.label || "",
    z: node.z || "",
  };
}

export function auditNodeRedFlowDrift(candidateFlow, liveFlow) {
  const candidateById = new Map(
    candidateFlow.filter((node) => node?.id).map((node) => [node.id, node]),
  );
  const liveById = new Map(
    liveFlow.filter((node) => node?.id).map((node) => [node.id, node]),
  );
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, liveNode] of liveById) {
    const candidateNode = candidateById.get(id);
    if (!candidateNode) {
      added.push(summarizeNode(liveNode));
      continue;
    }
    if (isDeepStrictEqual(candidateNode, liveNode)) continue;

    const fields = [...new Set([
      ...Object.keys(candidateNode),
      ...Object.keys(liveNode),
    ])]
      .filter(
        (key) => !isDeepStrictEqual(candidateNode[key], liveNode[key]),
      )
      .sort();
    changed.push({
      ...summarizeNode(liveNode),
      fields,
    });
  }

  for (const [id, candidateNode] of candidateById) {
    if (!liveById.has(id)) removed.push(summarizeNode(candidateNode));
  }

  return {
    candidateCount: candidateFlow.length,
    liveCount: liveFlow.length,
    added,
    removed,
    changed,
  };
}

function main() {
  const [candidatePath, livePath] = process.argv.slice(2);
  if (!candidatePath || !livePath) {
    console.error(
      "Usage: node scripts/audit_nodered_flow_drift.mjs <candidate-flow.json> <live-flow.json>",
    );
    process.exit(1);
  }

  const candidateFlow = JSON.parse(readFileSync(candidatePath, "utf8"));
  const liveFlow = JSON.parse(readFileSync(livePath, "utf8"));
  console.log(JSON.stringify(auditNodeRedFlowDrift(candidateFlow, liveFlow), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

#!/usr/bin/env node
import fs from "node:fs";
import { validateDeploymentCandidate } from "./runtime_contract.mjs";

const [livePath, candidatePath] = process.argv.slice(2);
if (!livePath || !candidatePath) {
  throw new Error("Usage: validate_candidate.mjs <reviewed-live-flow.json> <candidate-flow.json>");
}
const liveFlow = JSON.parse(fs.readFileSync(livePath, "utf8"));
const candidateFlow = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
process.stdout.write(`${JSON.stringify({ ok: true, ...validateDeploymentCandidate(liveFlow, candidateFlow) }, null, 2)}\n`);

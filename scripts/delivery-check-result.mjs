// Runs as the last step of the enforcement job with `if: always()`, including the case where
// an earlier gate failed before `npm ci` installed anything. It must therefore import only
// dependency-free modules: a crashing reporter hides the failure it was meant to explain.
import { readFileSync, appendFileSync } from 'node:fs';
import { requiredCheckSteps, validateOutcomes } from './delivery-outcome.mjs';
const checks = requiredCheckSteps(readFileSync('.github/workflows/lk1-subscription-enforcement.yml', 'utf8'));
const result = validateOutcomes(process.env.DELIVERY_PROFILE, checks, JSON.parse(process.env.DELIVERY_STEPS || '{}'));
const summary = result.report.map(row => `- ${row.id}: ${row.result} (${row.outcome})`).join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Required checks\n${summary}\n`);
if (!result.ok) process.exitCode = 1;

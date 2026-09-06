import { readFileSync, appendFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { validateOutcomes } from './delivery-policy.mjs';
const workflow = load(readFileSync('.github/workflows/lk1-subscription-enforcement.yml', 'utf8'));
const checks = workflow.jobs['lk1-exact-head'].steps.filter(step => step.id?.startsWith('check_')).map(step => ({
  id: step.id, category: step.env?.DELIVERY_CATEGORY ?? 'always',
}));
const result = validateOutcomes(process.env.DELIVERY_PROFILE, checks, JSON.parse(process.env.DELIVERY_STEPS || '{}'));
const summary = result.report.map(row => `- ${row.id}: ${row.result} (${row.outcome})`).join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Required checks\n${summary}\n`);
if (!result.ok) process.exitCode = 1;

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { classifyRange } from './delivery-policy.mjs';
const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
const repo = 'Z6v6e6r/lk';
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const run = event.workflow_run;
if (process.env.GITHUB_REPOSITORY !== repo || run?.repository?.full_name !== repo
  || run.conclusion !== 'success' || run.name !== 'LK1 Subscription Enforcement') throw new Error('Successful repository CI run required');
const branch = api(`repos/${repo}/branches/main`);
if (!branch.protected) throw new Error('Owner must protect main before enabling standard delivery');
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const policy = process.env.LK_FRONTEND_POLICY_SHA;
if (!/^[a-f0-9]{40}$/.test(policy || '')) throw new Error('Owner activation SHA required');
execFileSync('git', ['merge-base', '--is-ancestor', policy, source]);
if (classifyRange(policy, source).entries.some(entry => entry.profile === 'release')) throw new Error('Delivery mechanism changed since activation');
if (process.argv[2] === 'release') {
  if (run.event !== 'push' || run.head_branch !== 'main' || run.head_sha !== source || branch.commit.sha !== source) throw new Error('Release must be the successful exact current protected main push');
  const jobs = api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs;
  const gate = jobs.filter(job => job.name === 'LK1 exact-head enforcement gate');
  if (gate.length !== 1 || gate[0].conclusion !== 'success'
    || !gate[0].steps.some(step => step.name === 'Required delivery result' && step.conclusion === 'success')) throw new Error('Mandatory delivery check did not succeed');
} else {
  if (run.event !== 'pull_request' || source !== branch.commit.sha) throw new Error('Merge policy must run from current trusted main');
  const prs = api(`repos/${repo}/commits/${run.head_sha}/pulls`);
  const candidates = prs.filter(pr => pr.state === 'open' && !pr.draft && pr.base.ref === 'main'
    && pr.head.sha === run.head_sha && pr.head.repo?.full_name === repo);
  if (candidates.length !== 1) throw new Error('One ready exact-head same-repository PR required');
  const pr = candidates[0];
  const result = classifyRange(source, pr.head.sha, { pullRequest: true });
  if (!result.frontendEligible) throw new Error(`PR needs ${result.profile} handling outside the standard frontend route`);
  appendFileSync(process.env.GITHUB_OUTPUT, `number=${pr.number}\nhead=${pr.head.sha}\n`);
}

// Dependency-free delivery reporting helpers.
//
// `delivery-check-result.mjs` runs as the last step of the enforcement job with `if: always()`,
// so it must also work when an earlier gate failed before `npm ci` ran and no package is
// installed. That is exactly the case where its report matters most: a crashing reporter hides
// the real failure. This module therefore imports nothing but the language itself, and
// `delivery-policy.mjs` re-exports these helpers so the routing step keeps its single entry
// point.

const PROFILES = Object.freeze(['docs', 'frontend', 'business', 'release']);

export function requiredOutcome(profile, category) {
  return category === 'always' || (category === 'app' && profile !== 'docs')
    || (category === 'business' && ['business', 'release'].includes(profile))
    || (category === 'release' && profile === 'release');
}

export function validateOutcomes(profile, checks, outcomes) {
  if (!PROFILES.includes(profile)) throw new Error('Missing valid routing result');
  const report = checks.map(({ id, category }) => {
    const outcome = outcomes[id]?.outcome;
    const required = requiredOutcome(profile, category);
    const pass = required ? outcome === 'success' : outcome === 'skipped';
    return { id, required, outcome: outcome ?? 'missing', result: pass ? (required ? 'PASS' : 'NOT_APPLICABLE') : 'FAIL' };
  });
  return { ok: report.every(row => row.result !== 'FAIL'), report };
}

// Reads only what the report needs from the workflow text: every `check_*` step id of the
// enforcement job and its DELIVERY_CATEGORY. A YAML library would be more general, but it is
// also exactly what is unavailable when the report is most needed.
export function requiredCheckSteps(workflowText, job = 'lk1-exact-head') {
  const lines = String(workflowText).split('\n');
  const start = lines.findIndex(line => line === `  ${job}:`);
  if (start < 0) throw new Error(`Workflow job ${job} not found`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[^\s#]/.test(lines[index])) { end = index; break; }
  }
  const steps = [];
  let current = null;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    if (/^ {6}- /.test(line)) { current = { id: null, category: 'always' }; steps.push(current); continue; }
    if (!current) continue;
    const id = /^ {8}id: (.+?)\s*$/.exec(line);
    if (id) { current.id = id[1]; continue; }
    const category = /^ {8,}DELIVERY_CATEGORY:\s*(\S+)\s*$/.exec(line);
    if (category) current.category = category[1];
  }
  return steps.filter(step => typeof step.id === 'string' && step.id.startsWith('check_'))
    .map(step => ({ id: step.id, category: step.category }));
}

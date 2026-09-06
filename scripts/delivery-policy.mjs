import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const git = (args, cwd) => execFileSync('git', ['--no-replace-objects', ...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const sha = /^[a-f0-9]{40}$/;
const mechanism = /^(?:AGENTS\.md|\.github\/|package(?:-lock)?\.json|(?:vite|tsconfig|eslint)[^/]*|scripts\/|docs\/(?:README_DEPLOY|NODERED_MODULAR_WORKFLOW|FRONTEND_DELIVERY)|docs\/.*loader|src\/utils\/(?:widgetLoader|overlayBundleUrl|bundleVersion|releaseGuard|lkAssetBaseUrls|forceAppRefresh)|src\/academy\/)/;

// Only literal text/class/accessibility attributes on native HTML elements are erased.
// Imports, handlers, URLs, conditions, expressions and custom-component props remain exact.
export function presentationSignature(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (file.parseDiagnostics.length) return null;
  const edits = [];
  function visit(node) {
    if (ts.isJsxText(node) && ts.isJsxElement(node.parent)
      && /^[a-z][a-z0-9]*$/.test(node.parent.openingElement.tagName.getText(file))) {
      edits.push([node.pos, node.end, 'TEXT']);
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
      && /^(?:className|title|aria-label|placeholder)$/.test(node.name.getText(file))) {
      const element = node.parent.parent;
      if (/^[a-z][a-z0-9]*$/.test(element.tagName.getText(file))) {
        edits.push([node.initializer.getStart(file), node.initializer.end, '"TEXT"']);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  let result = source;
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + value + result.slice(end);
  return result;
}

export function classifyChange({ path, before, after, mode = '100644' }) {
  if (mode !== '100644' || mechanism.test(path)) return 'release';
  if (/^(?:docs\/.*\.md|README\.md)$/.test(path)) return 'docs';
  if (/^src\/.*\.css$/.test(path)) return 'frontend';
  if (/^src\/components\/.*\.tsx$/.test(path) && before && after) {
    const oldSignature = presentationSignature(before, path);
    if (oldSignature !== null && oldSignature === presentationSignature(after, path)) return 'frontend';
  }
  // Executable frontend changes need business regressions; no broad src allowlist.
  if (/^src\//.test(path)) return 'business';
  return 'release';
}

export function classifyChanges(changes) {
  const entries = changes.map(change => ({ path: change.path, profile: classifyChange(change) }));
  const rank = ['docs', 'frontend', 'business', 'release'];
  const profile = entries.length ? rank[Math.max(...entries.map(entry => rank.indexOf(entry.profile)))] : 'docs';
  return { profile, risk: profile === 'docs' || profile === 'frontend' ? 'FAST' : 'CRITICAL',
    frontendEligible: profile === 'frontend', entries };
}

export function classifyRange(base, head, { cwd = process.cwd(), pullRequest = false } = {}) {
  if (!sha.test(base) || !sha.test(head)) throw new Error('Full immutable base/head SHA required');
  git(['cat-file', '-e', `${base}^{commit}`], cwd);
  git(['cat-file', '-e', `${head}^{commit}`], cwd);
  if (pullRequest) base = git(['merge-base', base, head], cwd).trim();
  else git(['merge-base', '--is-ancestor', base, head], cwd);
  const paths = git(['diff', '--name-only', '--no-renames', '-z', base, head], cwd).split('\0').filter(Boolean);
  const changes = paths.map(path => {
    if ([...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Unsupported Git path');
    const read = revision => {
      const entry = git(['ls-tree', revision, '--', path], cwd);
      return entry ? { mode: entry.split(' ')[0], text: git(['show', `${revision}:${path}`], cwd) } : { mode: '100644', text: '' };
    };
    const before = read(base), after = read(head);
    return { path, before: before.text, after: after.text, mode: before.mode !== '100644' ? before.mode : after.mode };
  });
  return { base, head, ...classifyChanges(changes) };
}

export function requiredOutcome(profile, category) {
  return category === 'always' || (category === 'app' && profile !== 'docs')
    || (category === 'business' && ['business', 'release'].includes(profile))
    || (category === 'release' && profile === 'release');
}

export function validateOutcomes(profile, checks, outcomes) {
  if (!['docs', 'frontend', 'business', 'release'].includes(profile)) throw new Error('Missing valid routing result');
  const report = checks.map(({ id, category }) => {
    const outcome = outcomes[id]?.outcome;
    const required = requiredOutcome(profile, category);
    const pass = required ? outcome === 'success' : outcome === 'skipped';
    return { id, required, outcome: outcome ?? 'missing', result: pass ? (required ? 'PASS' : 'NOT_APPLICABLE') : 'FAIL' };
  });
  return { ok: report.every(row => row.result !== 'FAIL'), report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = classifyRange(process.env.BASE_SHA, process.env.EXPECTED_HEAD_SHA, { pullRequest: process.env.GITHUB_EVENT_NAME === 'pull_request' });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `profile=${result.profile}\n`);
}

#!/usr/bin/env node
// Public helper assets only. Production source/candidate never leave server147.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { sha256, buildPreview363Artifact } from './lib/preview363_activation.mjs';
import { buildPreview363BrowserGuard, buildPreview363EditorReadback } from './nodered_reviewed_flow_deploy/preview363_browser_guard.mjs';

export async function buildPreview363Assets(output, release) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(release || '') || git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('PREVIEW363_CLEAN_COMMIT_REQUIRED');
  if (!path.isAbsolute(output) || fs.realpathSync(output) !== output || output.startsWith(repo + '/')
    || !fs.statSync(output).isDirectory() || (fs.statSync(output).mode & 0o777) !== 0o700
    || fs.readdirSync(output).length) throw Error('PREVIEW363_NEW_PRIVATE_OUTPUT_REQUIRED');
  const copy = [
    'scripts/nodered_reviewed_flow_deploy/preview363_native_operation.mjs',
    'scripts/nodered_reviewed_flow_deploy/preview363_body_preserver.mjs',
    'scripts/nodered_reviewed_flow_deploy/preview363_browser_guard.mjs',
    'scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs',
    'scripts/lib/preview363_activation.mjs', 'scripts/lib/preview363_body_patch.mjs',
  ];
  const manifest = { sourceCommit: release, files: {} };
  const write = (name, bytes) => {
    const dest = path.join(output, name); fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 }); manifest.files[name] = sha256(bytes);
  };
  for (const name of copy) write(name, fs.readFileSync(path.join(repo, name)));
  const bundle = buildSync({ entryPoints: [path.join(repo, 'scripts/diagnostics/preview-empty-tariff-scoped.mjs')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false, legalComments: 'none',
    external: ['node:crypto', 'node:perf_hooks'] }).outputFiles[0].text;
  write('scripts/diagnostics/preview-empty-tariff-observer.bundle.cjs', bundle);
  const guard = buildPreview363BrowserGuard(buildPreview363Artifact(release, bundle));
  write('browser-guard.js', guard);
  write('editor-readback.js', `window.__preview363Readback = ${buildPreview363EditorReadback()};\nconsole.log('PREVIEW363_READBACK_READY');\n`);
  const module = await import(pathToFileURL(path.join(output, 'scripts/nodered_reviewed_flow_deploy/preview363_native_operation.mjs')));
  manifest.codeSha256 = module.preview363OperationCodeHash();
  manifest.bundleSha256 = sha256(bundle); manifest.browserGuardSha256 = sha256(guard);
  manifest.sourceOrCandidateIncluded = false;
  fs.writeFileSync(path.join(output, 'public-assets.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, release] = process.argv.slice(2);
  console.log(JSON.stringify(await buildPreview363Assets(output, release)));
}

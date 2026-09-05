#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { SOURCE_SHA } from './patch_live_subscription_create_preflight.mjs';
try {
  if (process.argv.length !== 3) throw new Error('Usage: <fresh-private-live-workspace>; fixture is mandatory');
  const verified = verifyWorkspace(process.argv[2], { quiet: true });
  if (verified.sourceSha256 !== SOURCE_SHA) throw new Error('Live source changed: refresh review required');
  const root = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const result = spawnSync(process.execPath, ['--test', 'scripts/tests/subscriptionCreatePreflight.test.mjs'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, LK_SUBSCRIPTION_CREATE_LIVE_FIXTURE: verified.sourcePath },
  });
  process.exitCode = result.status ?? 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }

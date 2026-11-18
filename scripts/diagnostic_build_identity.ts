import { execFileSync } from 'node:child_process';

// Capture this bundle's actual immutable source, not a mutable release manifest
// or an optional environment claim. Diagnostics must not make a build fail.
export function diagnosticBuildIdentity(cwd = process.cwd()): string {
  try {
    const options = { cwd, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    const source = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], options).trim();
    return /^[0-9a-f]{40}$/.test(source) && !dirty ? source : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}

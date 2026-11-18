import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the spectator wall holds the LK idle guard while it is mounted', () => {
  const source = readFileSync(new URL('../../src/components/padel-jump/LiveScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ useLkTournamentSession \} from '\.\.\/\.\.\/utils\/useLkTournamentSession';/);
  assert.match(source, /export default function LiveScreen\(\) \{[\s\S]*?useLkTournamentSession\(true\);/);
});

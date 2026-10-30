import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('production changes during upload stop activation after the shared lock and before staging', () => {
  const source = readFileSync(new URL('../deploy/linux/remote-release.sh', import.meta.url), 'utf8');
  const start = source.indexOf('# Check after taking the shared lock:');
  const end = source.indexOf('\nrelease_dir=', start);
  assert.ok(source.indexOf('flock -n 9') < start && start < end);
  const guard = source.slice(start, end);
  const root = mkdtempSync(join(tmpdir(), 'aftersale-release-guard-'));
  try {
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public/release.json'), JSON.stringify({ commit: 'a'.repeat(40) }));
    const run = expected => spawnSync('bash', ['-c', 'set -e\ncurrent_link="$1"\nexpected_production_commit="$2"\n' + guard,
      'guard', root, expected], { encoding: 'utf8', env: { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH } });
    assert.equal(run('a'.repeat(40)).status, 0);
    const changed = run('b'.repeat(40));
    assert.equal(changed.status, 76);
    assert.match(changed.stderr, /Production changed during build\/upload/);
    assert.equal(run('invalid').status, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

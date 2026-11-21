import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const release = readFileSync(new URL('../deploy/linux/remote-release.sh', import.meta.url), 'utf8');
const worker = release.match(/<<'PYWORKER'\r?\n([\s\S]*?)^PYWORKER\r?$/m)?.[1].replaceAll('\r\n', '\n');
assert.ok(worker, 'The actual immutable-worker installer must be present');
const start = worker.indexOf('names=['), end = worker.indexOf('\nidentity=');
assert.ok(start >= 0 && end > start, 'Only archive selection and byte loading run in this fixture');
const extraction = worker.slice(start, end);
const names = JSON.parse(extraction.match(/^names=(\[[^\n]+\])/)[1].replaceAll("'", '"'));

// Execute the production Python extraction against real in-memory ZIPs. Never
// run its root/dependency checks or installation at /usr/local/libexec.
function readSources(entries) {
  const script = `import io,json,stat,sys,warnings,zipfile
entries=json.loads(sys.argv[1])
archive=io.BytesIO()
with warnings.catch_warnings():
 warnings.simplefilter('ignore',UserWarning)
 with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as package:
  for entry in entries:
   info=zipfile.ZipInfo(entry['name']);info.create_system=3
   info.external_attr=((stat.S_IFLNK if entry.get('symlink') else stat.S_IFREG)|0o444)<<16
   body=b'x'*(2*1024*1024+1) if entry.get('oversized') else entry['body'].encode()
   package.writestr(info,body,compress_type=zipfile.ZIP_DEFLATED)
archive.seek(0)
${extraction}
print(json.dumps({name:body.decode() for name,body in contents.items()},sort_keys=True))
`;
  return spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-', JSON.stringify(entries)], {
    input: script, encoding: 'utf8', timeout: 10000,
  });
}

function sources(prefix = '') {
  return names.map((name, index) => ({ name: prefix + name, body: `original worker source ${index}\n` }));
}

test('immutable worker sources retain identical bytes for plain, dot-prefixed and mixed ZIP names', () => {
  const expected = Object.fromEntries(sources().map(entry => [entry.name, entry.body]));
  for (const entries of [sources(), sources('./'), sources().map((entry, index) => ({ ...entry, name: (index % 2 ? './' : '') + entry.name }))]) {
    const result = readSources(entries);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test('duplicate equivalent worker paths remain rejected instead of choosing one version', () => {
  for (const duplicate of [sources()[0], sources('./')[0]]) {
    const result = readSources([...sources(), { ...duplicate, body: 'different worker source' }]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid immutable worker source/);
  }
});

test('missing, linked, oversized or noncanonical worker entries remain rejected', () => {
  const rejected = [
    sources().slice(1),
    sources().map((entry, index) => index ? entry : { ...entry, symlink: true }),
    sources('./').map((entry, index) => index ? entry : { ...entry, oversized: true }),
    ...['../', '/', '././'].map(prefix => sources().map((entry, index) => index ? entry : { ...entry, name: prefix + entry.name })),
  ];
  for (const entries of rejected) {
    const result = readSources(entries);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid immutable worker source/);
  }
});

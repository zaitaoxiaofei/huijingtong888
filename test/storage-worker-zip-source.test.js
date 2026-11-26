import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const release = readFileSync(new URL('../deploy/linux/remote-release.sh', import.meta.url), 'utf8');
const worker = release.match(/<<'PYWORKER'\r?\n([\s\S]*?)^PYWORKER\r?$/m)?.[1].replaceAll('\r\n', '\n');
assert.ok(worker, 'The actual immutable-worker installer must be present');
const start = worker.indexOf('names=['), end = worker.indexOf('\nidentity=');
assert.ok(start >= 0 && end > start, 'Only archive selection and byte loading run in this fixture');
const extraction = worker.slice(start, end);
const identityStatement = worker.slice(end + 1, worker.indexOf('\nroot=', end));
assert.match(identityStatement, /^identity=hashlib\.sha256/);
const names = JSON.parse(extraction.match(/^names=(\[[^\n]+\])/)[1].replaceAll("'", '"'));

// Execute the production Python extraction against real in-memory ZIPs. Never
// run its root/dependency checks or installation at /usr/local/libexec.
function readSources(entries, { includeIdentity = false } = {}) {
  const script = `import io,json,stat,sys,warnings,zipfile,hashlib,pathlib
entries=json.loads(sys.stdin.read())
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
dependencies=pathlib.Path('/fixture/dependencies/node_modules')
${identityStatement}
print(json.dumps(${includeIdentity ? "{'contents':{name:body.decode() for name,body in contents.items()},'identity':identity}" : '{name:body.decode() for name,body in contents.items()}'},sort_keys=True))
`;
  return spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-c', script], {
    input: JSON.stringify(entries), encoding: 'utf8', timeout: 10000,
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

test('extracted real worker imports its OSS factory without archiving or connecting to a database', () => {
  const entries=names.map(name=>({name:'./'+name,body:readFileSync(new URL('../'+name,import.meta.url),'utf8')}));
  const extracted=readSources(entries);
  assert.equal(extracted.status,0,extracted.error?.message||extracted.stderr);
  const root=mkdtempSync(path.join(os.tmpdir(),'immutable-worker-load-'));
  try {
    for(const [name,body] of Object.entries(JSON.parse(extracted.stdout))){const file=path.join(root,name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,body,'utf8');}
    writeFileSync(path.join(root,'package.json'),'{"type":"module","private":true}\n','utf8');
    const dependencies=realpathSync(fileURLToPath(new URL('../node_modules',import.meta.url)));
    symlinkSync(dependencies,path.join(root,'node_modules'),process.platform==='win32'?'junction':'dir');
    const entry=pathToFileURL(path.join(root,'scripts/archive-mysql-binlogs.mjs')).href;
    const result=spawnSync(process.execPath,['--input-type=module','-e',`const {runBinlogArchive}=await import(${JSON.stringify(entry)});const result=await runBinlogArchive([],{BINLOG_ARCHIVE_ENABLED:'0'});if(result.status!=='disabled'||result.purged_files!==0)throw Error('Archive execution must remain disabled');console.log('isolated worker loaded; archive disabled');`],{cwd:root,encoding:'utf8',timeout:10000,env:{...process.env,BINLOG_ARCHIVE_ENABLED:'0',DB_HOST:'127.0.0.1',DB_NAME:'unused_worker_fixture',DB_USER:'unused',DB_PASSWORD:'',OSS_ENABLED:'false'}});
    assert.equal(result.status,0,result.error?.message||result.stderr);
    assert.match(result.stdout,/isolated worker loaded; archive disabled/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('immutable-worker-load-'));
    rmSync(root,{recursive:true,force:true});
  }
});

test('OSS factory bytes are included in the immutable worker identity', () => {
  const entries=names.map(name=>({name,body:readFileSync(new URL('../'+name,import.meta.url),'utf8')}));
  const original=readSources(entries,{includeIdentity:true});
  const changed=readSources(entries.map(entry=>entry.name==='src/services/oss-client.js'?{...entry,body:entry.body+'\n// Changed factory fixture\n'}:entry),{includeIdentity:true});
  for(const result of [original,changed])assert.equal(result.status,0,result.error?.message||result.stderr);
  assert.notEqual(JSON.parse(original.stdout).identity,JSON.parse(changed.stdout).identity);
});

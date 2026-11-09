import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dependencyIdentity, inspectDependencyCache } from "../scripts/lib/release-dependencies.mjs";

const unix={skip:process.platform === "win32"};
const execute=promisify(execFile);
const client=await fs.readFile(new URL('../deploy/linux/deploy-ecs.sh',import.meta.url),'utf8');
const remote=await fs.readFile(new URL('../deploy/linux/remote-release.sh',import.meta.url),'utf8');
const extract=(source,name)=>{const match=source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`,'m'));assert.ok(match);return match[0];};
async function fixture(body){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'release-lifecycle-'));
  try{await body(root);}finally{
    const writable=async dir=>{await fs.chmod(dir,0o755);for(const entry of await fs.readdir(dir,{withFileTypes:true}))if(entry.isDirectory())await writable(path.join(dir,entry.name));};
    await writable(root);await fs.rm(root,{recursive:true,force:true});
  }
}

test('SSH stdin cannot consume the next external tool manifest record',unix,()=>fixture(async root=>{
  const loop=client.slice(client.indexOf("while IFS=$'\\t' read -r object_hash"),client.indexOf("printf 'Splitting release artifact"));
  await fs.writeFile(path.join(root,'external-files.tsv'),'first\\tcompressed-first\nsecond\\tcompressed-second\n'.replaceAll('\\t','\t'));
  const result=await execute('bash',['--noprofile','--norc','-c',`
set -euo pipefail
work_dir="$PWD"
remote_target=fixture
remote_archive=fixture
output_dir=fixture
ssh_options=(-p 22)
ssh(){ cat >/dev/null; [[ "\${!#}" == install* ]]; }
file_hash(){ printf '%s' "$compressed_hash"; }
upload_verified_file(){ cat >/dev/null; printf '%s\\n' "$object_hash"; }
fail(){ exit 1; }
{
${loop}
} </dev/null
`],{cwd:root,env:{...process.env,BASH_ENV:''}});
  assert.equal(result.stdout,'first\nsecond\n');
}));

test('a missing transient unit cannot be mistaken for a successful release after reboot',unix,()=>fixture(async root=>{
  const result=await execute('bash',['--noprofile','--norc','-c',`
set -euo pipefail
release_unit=fixture
remote_target=deployment.test.invalid
ssh_options=(-p 22)
remote_job_finished=0
ssh(){ printf 'LoadState=not-found\nActiveState=inactive\nResult=success\nExecMainStatus=0\n'; }
${extract(client,'wait_for_remote_release')}
if wait_for_remote_release;then exit 91;fi
[[ "$remote_job_finished" == 0 ]]
`],{cwd:root,env:{...process.env,BASH_ENV:''}});
  assert.match(result.stderr,/verify the running version/);
}));

test('release polling reconnects after a failed SSH probe and accepts only terminal success',unix,()=>fixture(async root=>{
  const result=await execute('bash',['--noprofile','--norc','-c',`
set -euo pipefail
release_unit=fixture
remote_target=deployment.test.invalid
ssh_options=(-p 22)
remote_job_finished=0
sleep(){ :; }
ssh(){
 if [[ "\${!#}" == journalctl* ]]; then return; fi
 count=$(cat "$PWD/count" 2>/dev/null || printf 0); count=$((count+1)); printf '%s' "$count" > "$PWD/count"
 if [[ "$count" == 1 ]]; then return 255; fi
 if [[ "$count" == 2 ]]; then printf 'LoadState=loaded\nActiveState=active\nResult=success\nExecMainStatus=0\n'; return; fi
 printf 'LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\n'
}
${extract(client,'wait_for_remote_release')}
wait_for_remote_release
[[ "$remote_job_finished" == 1 ]]
`],{cwd:root,env:{...process.env,BASH_ENV:''}});
  assert.equal(result.stderr,'');assert.equal(await fs.readFile(path.join(root,'count'),'utf8'),'3');
}));

test('unknown background result retains its private manifests; a terminal failure can clean them',unix,()=>fixture(async root=>{
  for(const terminal of [false,true]){
    const result=await execute('bash',['--noprofile','--norc','-c',`
set -euo pipefail
release_unit=fixture
remote_target=deployment.test.invalid
ssh_options=(-p 22)
work_dir="$PWD/work"
mkdir -p "$work_dir"
remote_job_started=1
remote_job_finished=0
numbering_upload_attempted=1
remote_inventory_numbering_manifest="$PWD/private.json"
consumables_upload_attempted=0
retention_upload_attempted=0
material_upload_attempted=0
sleep(){ SECONDS=$((SECONDS+1900)); }
ssh(){
 if [[ "\${!#}" == 'rm -f -- '* ]]; then printf cleaned > "$PWD/trace";return;fi
 if [[ "\${!#}" == journalctl* ]]; then return;fi
 ${terminal ? "printf 'LoadState=loaded\nActiveState=failed\\nResult=exit-code\\nExecMainStatus=1\\n'" : 'return 255'}
}
${extract(client,'cleanup')}
${extract(client,'wait_for_remote_release')}
if wait_for_remote_release;then exit 91;fi
cleanup
`],{cwd:root,env:{...process.env,BASH_ENV:''}});
    if(terminal)assert.equal(await fs.readFile(path.join(root,'trace'),'utf8'),'cleaned');
    else{assert.match(result.stderr,/private manifests retained/);await assert.rejects(fs.access(path.join(root,'trace')),{code:'ENOENT'});}
  }
}));

test('actual dependency preparation installs once, reuses an immutable entry, and preserves rollback links',unix,()=>fixture(async root=>{
  const helperSource=fileURLToPath(new URL('../scripts/lib/release-dependencies.mjs',import.meta.url));
  const cache=path.join(root,'cache');
  const runtime={node:'test',abi:'test',platform:'linux',arch:'x64',libc:'test',npm:'test'};
  const prepare=async(name,lock)=>{
    const staging=path.join(root,name);await fs.mkdir(path.join(staging,'scripts/lib'),{recursive:true});
    await fs.copyFile(helperSource,path.join(staging,'scripts/lib/release-dependencies.mjs'));
    await fs.writeFile(path.join(staging,'package.json'),'{"dependencies":{}}');
    await fs.writeFile(path.join(staging,'package-lock.json'),lock);
    const key=await dependencyIdentity(staging,runtime);
    await execute('bash',['--noprofile','--norc','-c',`
set -euo pipefail
staging_dir="$STAGING"
dependency_cache_root="$CACHE"
chown(){ :; }
install_release_dependencies(){ printf installed >> "$TRACE";mkdir -p "$staging_dir/node_modules";printf '%s' "$KEY" > "$staging_dir/node_modules/value"; }
node(){
 if [[ "$2" == key ]];then printf '%s' "$KEY";
 elif [[ "$2" == find ]];then "$NODE_BIN" --input-type=module -e 'import {pathToFileURL} from "node:url";const {inspectDependencyCache}=await import(pathToFileURL(process.env.HELPER_SOURCE));const entry=await inspectDependencyCache(process.argv[1],process.argv[2],{uid:process.getuid()});if(entry)console.log(entry);' "$3" "$4";
 else "$NODE_BIN" "$@";fi
}
${extract(remote,'prepare_release_dependencies')}
prepare_release_dependencies
`],{cwd:root,env:{...process.env,BASH_ENV:'',STAGING:staging,CACHE:cache,KEY:key,TRACE:path.join(root,'trace'),NODE_BIN:process.execPath,HELPER_SOURCE:helperSource}});
    assert.ok(await inspectDependencyCache(cache,key,{uid:process.getuid()}));
    return {key,link:path.join(staging,'node_modules')};
  };
  const first=await prepare('first','{"lock":1}'),second=await prepare('second','{"lock":1}');
  assert.equal(first.key,second.key);assert.equal(await fs.readFile(path.join(root,'trace'),'utf8'),'installed');
  const third=await prepare('third','{"lock":2}');assert.notEqual(first.key,third.key);
  assert.equal(await fs.readFile(path.join(root,'trace'),'utf8'),'installedinstalled');
  assert.equal(await fs.readFile(path.join(first.link,'value'),'utf8'),first.key);
  assert.equal(await fs.readFile(path.join(third.link,'value'),'utf8'),third.key);
}));

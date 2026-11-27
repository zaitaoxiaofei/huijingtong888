import{fileURLToPath}from'node:url';import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import{execFileSync}from'node:child_process';
const root=new URL('../',import.meta.url);
test('finance release explicitly skips installation even when storage flags are enabled',async()=>{
 const source=await fs.readFile(new URL('deploy/linux/remote-release.sh',root),'utf8'),block=source.match(/if \[\[ "\$skip_storage_lifecycle_setup" == "1" \]\]; then[\s\S]*?(?=# A failed release)/)[0];
 for(const [skip,enabled,expectInstall]of[['1','1',false],['0','1',true],['0','0',false]]){const stdout=execFileSync('/bin/bash',['-c','install_storage_lifecycle_timers(){ echo INSTALL_CALLED; };'+block],{encoding:'utf8',env:{...process.env,skip_storage_lifecycle_setup:skip,BINLOG_ARCHIVE_ENABLED:enabled,MEDIA_CACHE_LIFECYCLE_ENABLED:enabled}});assert.equal(stdout.includes('INSTALL_CALLED'),expectInstall);if(skip==='1')assert.match(stdout,/existing workers, timers and flags left unchanged/);}
 assert.match(source,/skip_storage_lifecycle_setup="\$\{12:-0\}"/);
});
test('dry-run forwards all empty positional placeholders before the skip flag without connecting',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storage-release-skip-')),key=path.join(dir,'key');try{await fs.writeFile(key,'test key',{mode:0o600});
 const stdout=execFileSync('/bin/bash',[fileURLToPath(new URL('deploy/linux/deploy-ecs.sh',root)),'--host','deployment.test.invalid','--identity-file',key,'--version','skip-test','--skip-storage-lifecycle-setup','--dry-run'],{encoding:'utf8',env:{...process.env,PATH:path.dirname(process.execPath)+':'+process.env.PATH}});assert.match(stdout,/DryRun only/);assert.match(stdout,/Activation arguments:.*'0' '' '' '0' '' '' '' '' '1'/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

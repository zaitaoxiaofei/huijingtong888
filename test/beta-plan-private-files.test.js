import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='unused';process.env.DB_USER||='unused';
const {createTenantPrivateFiles}=await import('../src/services/tenant-private-files.js');
test('known finance and task attachment URLs do not bypass a downgraded plan',async()=>{
 for(const [plan_code,purpose,allowed] of [['trial_1d','finance',false],['trial_7d','team',false],['monthly','finance',true],['monthly','team',false],['monthly_team','team',true]]){
 const actor={personId:1,roles:['admin'],tenant:{id:42,slug:'a',role:'owner',plan_code}};
 const files=createTenantPrivateFiles({authorize:async()=>actor,query:async()=>[{tenant_id:42,purpose,storage_name:'receipt.pdf'}]});
 const result=files.owned('/uploads/team-attachments/receipt.pdf',actor);
 if(allowed)assert.equal((await result).tenant_id,42);else await assert.rejects(result,error=>error.statusCode===403);
 }
});

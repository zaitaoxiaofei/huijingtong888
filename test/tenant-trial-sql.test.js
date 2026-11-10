import test from 'node:test';
import assert from 'node:assert/strict';
import { claimTenantTrial, tenantHasUsedTrial } from '../src/services/tenant-trial-eligibility.js';
let DatabaseSync;
try { ({DatabaseSync}=await import('node:sqlite')); } catch {}
test('trial marker persists through real SQL, preserves other flags, detects voucher history and rolls back', {skip:!DatabaseSync}, async t => {
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.function('JSON_UNQUOTE',x=>x);
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,feature_flags_json TEXT);
    CREATE TABLE tenant_subscription_vouchers(id INTEGER PRIMARY KEY,used_by_tenant_id INTEGER,status TEXT,plan_snapshot_json TEXT);
    INSERT INTO tenants VALUES(1,'{"ai_credit_wallet_enabled":true}'),(2,NULL),(3,NULL);`);
  const connection={execute:async(sql,params)=>sql.trim().startsWith('SELECT')?[db.prepare(sql).all(...params)]:[db.prepare(sql).run(...params)]};
  const tenant=id=>({id,...db.prepare('SELECT feature_flags_json FROM tenants WHERE id=?').get(id)});
  await claimTenantTrial(connection,tenant(1),{plan_code:'trial_1d',subscription_status:'trial'});
  assert.equal(tenantHasUsedTrial(tenant(1)),true);
  assert.equal(JSON.parse(tenant(1).feature_flags_json).ai_credit_wallet_enabled,true);
  await assert.rejects(claimTenantTrial(connection,tenant(1),{plan_code:'trial_7d',subscription_status:'trial'}),/已使用体验/);
  // A custom editable type must not make a known trial code reusable.
  await assert.rejects(claimTenantTrial(connection,tenant(1),{code:'trial_7d',subscription_status:'active'}),/已使用体验/);
  db.prepare('INSERT INTO tenant_subscription_vouchers VALUES(?,?,?,?)').run(1,2,'used',JSON.stringify({subscription_status:'trial'}));
  await assert.rejects(claimTenantTrial(connection,tenant(2),{subscription_status:'trial'}),/已使用体验/);
  db.exec('BEGIN');await claimTenantTrial(connection,tenant(3),{subscription_status:'trial'});db.exec('ROLLBACK');
  assert.equal(tenantHasUsedTrial(tenant(3)),false);
  await claimTenantTrial(connection,{...tenant(3),plan_code:'trial_7d',subscription_status:'expired'},{subscription_status:'active'});
  assert.equal(tenantHasUsedTrial(tenant(3)),true);
});

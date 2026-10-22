import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantMysqlFixture } from './helpers/tenant-mysql-fixture.js';
import { subscribeGlobalUpdateEvents, broadcastGlobalEvent } from '../src/server/notifications.js';

test('SSE rechecks the actual saved login session before enterprise event delivery',{
  skip:!process.env.TENANT_TEST_MYSQL_SOCKET&&'Set TENANT_TEST_MYSQL_SOCKET to isolated MySQL',timeout:180000
},async t=>{
  const fixture=await createTenantMysqlFixture('events');fixture.useEnvironment();
  const {createSessionMysql,getSessionMysql,destroySessionMysql}=await import('../src/services/mysql-auth-session.js');
  const {switchSessionTenantMysql}=await import('../src/services/tenants.js');
  const {closeMysqlPool}=await import('../src/mysql-pool.js');
  const {query}=fixture;
  const clients=[];
  async function connect(token){
    const session=await getSessionMysql(token);
    assert.ok(session);
    const chunks=[];
    const res={writableEnded:false,destroyed:false,write(chunk){chunks.push(chunk);},end(){this.writableEnded=true;}};
    const unsubscribe=subscribeGlobalUpdateEvents(res,{person_id:99,tenant_id:99},session,{authorize:()=>getSessionMysql(token)});
    const client={res,unsubscribe,clear(){chunks.length=0;},text(){return chunks.join('');}};
    client.clear();clients.push(client);return client;
  }
  async function session(token,personId,tenantId){
    await createSessionMysql({token,personId,activeTenantId:tenantId,name:`Fixture ${personId}`,role:'operations',expiresAt:new Date(Date.now()+3600000).toISOString()});
  }
  try{
    await query("INSERT INTO tenants(id,slug,name) VALUES (1,'default','Default'),(2,'a','A'),(3,'b','B')");
    await query("INSERT INTO people(id,name,role) VALUES (1,'Default operator','operations'),(2,'A operator','operations'),(3,'B operator','operations')");
    await query("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES (1,1,'member',JSON_ARRAY('operations')),(2,2,'member',JSON_ARRAY('operations')),(3,3,'member',JSON_ARRAY('operations')),(3,2,'member',JSON_ARRAY('operations'))");
    await t.test('default, A and B receive only their own targeted or compatible legacy events',async()=>{
      for(const id of [1,2,3])await session(`scope-${id}`,id,id);
      const current=await Promise.all([1,2,3].map(id=>connect(`scope-${id}`)));
      for(const id of [1,2,3])await broadcastGlobalEvent('fixture',{marker:`private-${id}`},{personId:id,tenantId:id});
      for(const id of [1,2,3]){
        assert.match(current[id-1].text(),new RegExp(`private-${id}`));
        for(const other of [1,2,3].filter(value=>value!==id))assert.doesNotMatch(current[id-1].text(),new RegExp(`private-${other}`));
      }
      await broadcastGlobalEvent('fixture',{marker:'legacy-default-only'});
      assert.match(current[0].text(),/legacy-default-only/);
      assert.doesNotMatch(current[1].text(),/legacy-default-only/);
      assert.doesNotMatch(current[2].text(),/legacy-default-only/);
      current.forEach(client=>client.unsubscribe());
    });
    for(const [name,mutate,restore]of[
      ['membership revoked',()=>query('UPDATE tenant_members SET active=0 WHERE tenant_id=2 AND person_id=2'),()=>query('UPDATE tenant_members SET active=1 WHERE tenant_id=2 AND person_id=2')],
      ['enterprise disabled',()=>query("UPDATE tenants SET status='disabled' WHERE id=2"),()=>query("UPDATE tenants SET status='active' WHERE id=2")],
      ['subscription expired',()=>query("UPDATE tenants SET subscription_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY) WHERE id=2"),()=>query('UPDATE tenants SET subscription_expires_at=NULL WHERE id=2')],
      ['person disabled',()=>query('UPDATE people SET active=0 WHERE id=2'),()=>query('UPDATE people SET active=1 WHERE id=2')],
      ['token logged out',()=>destroySessionMysql('revoke'),async()=>{}],
      ['token expired',()=>query("UPDATE sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE token='revoke'"),async()=>{}],
      ['same token switched enterprise',()=>switchSessionTenantMysql('revoke',2,3),async()=>{}]
    ])await t.test(`${name}: old connection closes with zero private payload`,async()=>{
      await query("DELETE FROM sessions WHERE token='revoke'");
      await session('revoke',2,2);
      const client=await connect('revoke');
      await mutate();
      await broadcastGlobalEvent('fixture',{marker:'must-not-arrive'},{tenantId:2,personId:2});
      assert.equal(client.text(),'');assert.equal(client.res.writableEnded,true);
      await restore();client.unsubscribe();
    });
    await t.test('new connection after an explicit tenant switch receives B and cannot revive A stream',async()=>{
      const client=await connect('revoke');
      await broadcastGlobalEvent('fixture',{marker:'private-a'},{tenantId:2,personId:2});
      await broadcastGlobalEvent('fixture',{marker:'private-b'},{tenantId:3,personId:2});
      assert.doesNotMatch(client.text(),/private-a/);assert.match(client.text(),/private-b/);
    });
  }finally{
    clients.forEach(client=>client.unsubscribe());
    await closeMysqlPool();await fixture.cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_HOST='127.0.0.1';process.env.DB_NAME='unused';process.env.DB_USER='unused';
process.env.SITE_ACCESS_PASSWORD='local-entry-test-only';
const {createAuthHandler}=await import('../src/server/session.js');
test('public visitors receive account login options without opening legacy QR endpoints',async t=>{
 const before=process.env.SELF_SERVICE_PUBLIC_ENABLED;t.after(()=>{if(before===undefined)delete process.env.SELF_SERVICE_PUBLIC_ENABLED;else process.env.SELF_SERVICE_PUBLIC_ENABLED=before;});
 const handler=createAuthHandler(async()=>({})),url=new URL('https://erp.example/api/auth/entry-options');
 process.env.SELF_SERVICE_PUBLIC_ENABLED='1';const req={method:'GET',headers:{host:'erp.example'},socket:{remoteAddress:'203.0.113.5'}};
 assert.equal((await handler(req,url)()).legacy_login_available,false);assert.equal(req._sensitiveResponse,true);
 process.env.SELF_SERVICE_PUBLIC_ENABLED='0';assert.equal((await handler({method:'GET',headers:{host:'erp.example'},socket:{remoteAddress:'203.0.113.5'}},url)()).legacy_login_available,true);
});

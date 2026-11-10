import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
process.env.DB_HOST||='127.0.0.1';process.env.DB_NAME||='unused';process.env.DB_USER||='unused';
const {isPublicEntry,publicWebsitePath,renderPublicWebsite,loadPublicPlans}=await import('../src/server/public-website.js');
const {DEFAULT_TENANT_PLAN_PRESETS}=await import('../src/services/tenant-plans.js');
test('public launch is opt-in and anonymous exceptions cover only reviewed entry requests',t=>{
 const before=process.env.SELF_SERVICE_PUBLIC_ENABLED;t.after(()=>{if(before===undefined)delete process.env.SELF_SERVICE_PUBLIC_ENABLED;else process.env.SELF_SERVICE_PUBLIC_ENABLED=before;});
 delete process.env.SELF_SERVICE_PUBLIC_ENABLED;assert.equal(isPublicEntry({method:'POST'},new URL('https://erp/api/auth/register')),false);
 process.env.SELF_SERVICE_PUBLIC_ENABLED='1';for(const [method,path] of [['POST','/api/auth/register'],['POST','/api/auth/login'],['GET','/admin.html'],['GET','/api/auth/me'],['GET','/api/auth/entry-options'],['GET','/website/erp-dashboard-demo.png']])assert.equal(isPublicEntry({method},new URL('https://erp'+path)),true);
 for(const [method,path] of [['GET','/api/auth/qr/start'],['GET','/api/orders'],['POST','/api/auth/billing/orders'],['GET','/api/tenants'],['POST','/api/auth/register/extra'],['DELETE','/api/auth/register'],['GET','/uploads/private.jpg']])assert.equal(isPublicEntry({method},new URL('https://erp'+path)),false,method+path);
 assert.equal(publicWebsitePath('/docs'),true);assert.equal(publicWebsitePath('/docs/private'),false);
});
test('public pages show actual sale plans without exposing credentials, and escape editable names',async()=>{
 const plans=await loadPublicPlans(async()=>DEFAULT_TENANT_PLAN_PRESETS.map(p=>({...p,name:p.code==='yearly'?'<script>unsafe</script>':p.name})));
 const html=renderPublicWebsite('/pricing',plans);for(const price of ['¥9.9','¥19.9','¥299','¥399','¥1099','¥3999'])assert.ok(html.includes(price),price);assert.doesNotMatch(html,/¥8999/);assert.match(html,/&lt;script&gt;unsafe/);assert.doesNotMatch(html,/<script>unsafe/);
 for(const path of ['/','/docs','/pricing']){const content=renderPublicWebsite(path,plans);assert.match(content,/href="\/register"/);assert.doesNotMatch(content,/API_V3_KEY|PRIVATE_KEY|ozp_/);}
 const home=renderPublicWebsite('/',plans);assert.match(home,/src="\/website\/erp-dashboard-demo.png"/);assert.match(home,/系统真实界面 · 演示数据/);assert.doesNotMatch(home,/mock-kpi|mock-side|chart-fill/);
});
test('public entry keeps business APIs behind authentication, isolation and subscription gates',()=>{
 const server=readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
 assert.match(server,/parts\[0\] === "api" \|\| isPrivateAttachmentPath\(url.pathname\)/);
 for(const guard of ['tenantIsolationDecision(session, parts, req.method)','authorizeApiRequest(req, parts)','subscriptionAccessDecision(session, parts, req.method)'])assert.ok(server.includes(guard),guard);
 assert.doesNotMatch(server,/commerceRoutes|commerce_payment_reconcile|ALIPAY_NOTIFY|WECHATPAY_NOTIFY/);
 const docs=renderPublicWebsite('/docs');assert.match(docs,/当前暂未开放在线支付/);assert.doesNotMatch(docs,/已支付并开通|查询支付记录/);
});

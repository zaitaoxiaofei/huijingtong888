import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';

test('procurement SLA check rejects warming or slow results and checks the real workspace only', async t=>{
  let mode='ready';const paths=[];
  const server=createServer(async(req,res)=>{
    paths.push(new URL(req.url,'http://127.0.0.1:8788').pathname);
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/auth/login'){res.end(JSON.stringify({token:'fixture-only',user:{id:1}}));return;}
    if(mode==='slow')await new Promise(resolve=>setTimeout(resolve,80));
    res.end(JSON.stringify({rows:mode==='warming'?[]:[{product_id:1}],total:mode==='warming'?null:1,
      snapshot:{available:mode!=='warming',stale:mode==='warming',refreshing:mode==='warming',status:mode==='warming'?'warming':'ready'}}));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8788,'127.0.0.1',resolve);});
  const check=extra=>new Promise(resolve=>execFile(process.execPath,['scripts/health-check.mjs'],{
    cwd:new URL('..',import.meta.url),env:{...process.env,DB_CLIENT:'mysql',DB_HOST:'localhost',DB_NAME:'unused_health_fixture',DB_USER:'root',
      HEALTH_CHECK_BASE_URL:'http://127.0.0.1:8788',HEALTH_CHECK_USERNAME:'fixture',HEALTH_CHECK_PASSWORD:'fixture',
      HEALTH_CHECK_LABELS:'procurement_workspace_paged',HEALTH_CHECK_MAX_DURATION_MS:'1000',HEALTH_CHECK_REQUIRE_FRESH_SNAPSHOT:'1',...extra}
  },(error,stdout,stderr)=>resolve({code:error?.code||0,stdout,stderr})));
  try{
    await t.test('one second budget accepts the complete ready result',async()=>{
      const result=await check();assert.equal(result.code,0,result.stderr);
      const report=JSON.parse(result.stdout);assert.equal(report.failedCount,0);assert.equal(report.results.length,1);
      assert.equal(report.results[0].label,'procurement_workspace_paged');assert.equal(report.results[0].summary.total,1);
      assert.deepEqual(paths.splice(0),['/api/auth/login','/api/inventory-workflow/alerts']);
    });
    await t.test('a fast warming empty response cannot pass the SLA check',async()=>{
      mode='warming';const result=await check();assert.equal(result.code,1);
      const report=JSON.parse(result.stdout);assert.equal(report.failedCount,1);assert.equal(report.results[0].summary.total,null);
      assert.match(report.results[0].error,/fresh ready snapshot/);
    });
    await t.test('a complete ready response over the chosen budget fails',async()=>{
      mode='slow';const result=await check({HEALTH_CHECK_MAX_DURATION_MS:'20'});assert.equal(result.code,1);
      assert.match(JSON.parse(result.stdout).results[0].error,/exceeded 20ms budget/);
    });
    await t.test('unknown endpoint labels are rejected before credentials are sent',async()=>{
      paths.length=0;const result=await check({HEALTH_CHECK_LABELS:'https://invalid.example'});assert.notEqual(result.code,0);
      assert.deepEqual(paths,[]);assert.match(result.stderr,/unknown endpoint label/);
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("person editor saves multiple roles, restores them, and retains legacy single-role accounts", { skip: process.env.RUN_MULTI_ROLE_BROWSER_TESTS !== "1" }, async () => {
  const entry = `import { createApp } from 'vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
    import Settings from '/frontend/admin/views/settings/SettingsView.vue'; createApp(Settings).use(ElementPlus).mount('#app');`;
  const server = await createServer({ configFile:false,root:process.cwd(), optimizeDeps:{include:['vue','element-plus']},server:{host:'127.0.0.1',port:8788,strictPort:true,watch:{ignored:['**/.deploy-artifacts/**','**/public/**','**/dist/**']}},plugins:[vue(),{
    name:'people-roles-fixture',resolveId(id){if(id==='virtual:people-roles')return '\0people-roles';},load(id){if(id==='\0people-roles')return entry;},
    configureServer(server){server.middlewares.use('/admin.html',async(_req,res)=>{res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/admin.html','<html><body><div id="app"></div><script type="module" src="/@id/virtual:people-roles"></script></body></html>'));});}
  }] });
  let browser;
  try {
    await server.listen();browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1500,height:1050}});page.setDefaultTimeout(15000);
    let person={id:7,name:'测试员工',username:'worker',role:'operator',active:1};const writes=[],errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url());if(!url.pathname.startsWith('/api/'))return route.continue();let result=[];
      if(url.pathname==='/api/people'&&req.method()==='GET')result=[person];
      else if(url.pathname==='/api/people/7'&&req.method()==='PUT'){const body=req.postDataJSON();writes.push(body);person={...person,...body};result={ok:true};}
      await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
    });
    await page.goto('http://127.0.0.1:8788/admin.html#/settings');
    await page.getByRole('tab',{name:'人员管理'}).click();await page.getByRole('button',{name:'编辑',exact:true}).click();
    const dialog=page.getByRole('dialog');
    assert.equal(await dialog.getByRole('checkbox',{name:/通用业务/}).isChecked(),true);
    await dialog.locator('label.el-checkbox').filter({hasText:'通用业务'}).click();
    await dialog.locator('label.el-checkbox').filter({hasText:'打包（packing）'}).click();
    await dialog.locator('label.el-checkbox').filter({hasText:'采购（procurement）'}).click();
    await page.screenshot({path:'/tmp/multi-role-person-editor.png'});
    await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
    assert.deepEqual(writes[0].roles,['packing','procurement']);assert.equal('role' in writes[0],false);
    await page.getByRole('button',{name:'编辑',exact:true}).click();
    assert.equal(await dialog.getByRole('checkbox',{name:'打包（packing）',exact:true}).isChecked(),true);
    assert.equal(await dialog.getByRole('checkbox',{name:'采购（procurement）',exact:true}).isChecked(),true);
    assert.equal(await dialog.getByRole('checkbox',{name:/通用业务/}).isChecked(),false);
    await dialog.locator('label.el-checkbox').filter({hasText:'打包（packing）'}).click();await dialog.locator('label.el-checkbox').filter({hasText:'采购（procurement）'}).click();
    await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.getByText('请至少选择一个角色',{exact:true}).waitFor();assert.equal(writes.length,1);
    assert.deepEqual(errors,[]);
  } finally {if(browser)await browser.close();await server.close();}
});

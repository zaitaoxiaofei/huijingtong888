import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

test("inspiration creation shares category and brand with task center", { skip: process.env.RUN_IDEA_BROWSER_TESTS !== "1" }, async () => {
  const entry = `import {createApp} from 'vue';import {createPinia} from 'pinia';import {createRouter,createWebHashHistory} from 'vue-router';
    import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';
    import View from '/frontend/admin/views/team/ProductDevelopmentCenterView.vue';
    createApp(View).use(createPinia()).use(createRouter({history:createWebHashHistory(),routes:[{path:'/:pathMatch(.*)*',component:View}]})).use(ElementPlus).mount('#app');`;
  const server = await createServer({ configFile: false, root: process.cwd(), server: { host: "127.0.0.1", port: 8788, strictPort: true, watch: { ignored: ["**/.deploy-artifacts/**", "**/public/**"] } }, plugins: [vue(), {
    name: "idea-link-fixture", resolveId(id) { if (id === "virtual:idea-link") return '\0idea-link'; },
    load(id) { if (id === '\0idea-link') return entry; },
    configureServer(server) { server.middlewares.use('/admin.html', async (_req, res) => {
      res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/admin.html','<html><body><div id="app"></div><script type="module" src="/@id/virtual:idea-link"></script></body></html>'));
    }); }
  }] });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
    const page = await browser.newPage({viewport:{width:1450,height:1100}});page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
    const ideas=[];const tasks=[{id:9,title:'历史发货任务',type:'shipping_daily',automation_key:'shipping_daily:2026-09-06',status:'doing',target:10,done:1,created_at:new Date().toISOString(),owner_person_id:null}];const writes=[];const ownerWrites=[];
    const catalog=[{name:'TENET',models:[{id:1,name:'T4'},{id:2,name:'T7'}]},{name:'HAVAL',models:[{id:3,name:'H6'}]}];
    const categories=[{value:'汽车脚垫'},{value:'钥匙壳'}];const catalogWrites=[];
    await page.route('**/api/**' ,async route=>{
      const req=route.request();const path=new URL(req.url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let data=[];
      if(path==='/api/people')data=[{id:7,name:'负责人'}];
      else if(path==='/api/ai-variant-lab/vehicle-catalog' && req.method()==='POST'){
        const body=req.postDataJSON();catalogWrites.push(body);let brand=catalog.find(row=>row.name===body.brand);
        if(!brand){brand={name:body.brand,models:[]};catalog.push(brand);}
        if(body.model)brand.models.push({id:100+catalogWrites.length,name:body.model});data={ok:true,...body};
      } else if(path==='/api/ai-variant-lab/vehicle-catalog')data={brands:catalog};
      else if(path==='/api/inventory-product-naming/options' && req.method()==='POST'){
        const body=req.postDataJSON();const pending=body.value==='待审类目';if(!pending)categories.push({value:body.value});data={ok:true,value:body.value,status:pending?'pending':'active'};
      } else if(path==='/api/inventory-product-naming/options')data={rows:categories};
      else if(path==='/api/team/development-ideas'&&req.method()==='POST'){
        const body=req.postDataJSON();writes.push(body);
        ideas.push({...body,id:12,status:'idea',created_at:new Date().toISOString(),development_brand:'TENET、HAVAL',development_category:'汽车脚垫、钥匙壳'});
        body.development_tasks.forEach((group,index)=>tasks.push({id:44+index,source_idea_id:12,title:body.title+' '+(index+1),type:'product_development',status:'todo',target:group.models.reduce((sum,row)=>sum+row.target,0),done:0,created_at:new Date().toISOString(),automation_key:`idea_scope:12:${group.key}`,development_plan:{kind:'development_matrix',brand:group.models[0].brand,category:group.models[0].category,group_key:group.key,source_idea_id:12,models:group.models.map(row=>({...row,draft_ids:[],drafts:[],done:0}))}}));data={ok:true,id:12};
      } else if(path==='/api/team/development-ideas')data=ideas;
      else if(path==='/api/team/tasks/9' && req.method()==='PUT'){ownerWrites.push(req.postDataJSON());tasks[0].owner_person_id=req.postDataJSON().owner_person_id;data={ok:true};}
      else if(path==='/api/team/tasks')data=tasks;
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto('http://127.0.0.1:8788/admin.html#/team-plan');
    await page.locator('.task-row-actions button').first().click();
    const taskDialog=page.locator('.task-detail-dialog');
    await taskDialog.locator('.task-owner-card .el-select').click();
    await page.getByRole('option',{name:'负责人',exact:true}).click();
    await taskDialog.getByRole('button',{name:'保存负责人',exact:true}).click();
    await taskDialog.waitFor({state:'hidden'});
    assert.equal(ownerWrites.length,1);assert.equal(ownerWrites[0].owner_person_id,7);
    await page.getByRole('button',{name:'灵感列表',exact:true}).click();
    await page.getByRole('button',{name:'快速创建灵感',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'快速创建灵感'});
    await dialog.getByPlaceholder('一句话记录这个产品灵感').fill('TENET 脚垫安排');
    await dialog.getByRole('button',{name:'保存灵感',exact:true}).click();
    assert.equal(writes.length,0);
    await dialog.getByRole('button',{name:'打开开发坐标表 · 多选类目和车型'}).click();
    const picker=page.getByRole('dialog',{name:'选择开发范围与任务分组'});
    async function addCell(brand,category,models){
      await picker.getByRole('button',{name:`${brand} · ${category}，选择车型`,exact:true}).click();
      const config=page.getByRole('dialog',{name:`${brand} · ${category} · 选择车型`,exact:true});
      for(const model of models) await config.getByText(model,{exact:true}).click();
      await config.getByRole('button',{name:'加入开发范围',exact:true}).click();
      await config.waitFor({state:'hidden'});
    }
    await addCell('TENET','汽车脚垫',['T4','T7']);
    await addCell('TENET','钥匙壳',['T4']);
    await addCell('HAVAL','汽车脚垫',['H6']);
    await picker.getByText('已选 3 个范围 · 3 个任务 · 40 个 SKU',{exact:true}).waitFor();
    await picker.getByRole('checkbox',{name:'勾选 TENET 汽车脚垫',exact:true}).locator('xpath=ancestor::label').click();
    await picker.getByRole('checkbox',{name:'勾选 HAVAL 汽车脚垫',exact:true}).locator('xpath=ancestor::label').click();
    await picker.getByRole('button',{name:'合并勾选范围',exact:true}).click();
    await picker.getByText('已选 3 个范围 · 2 个任务 · 40 个 SKU',{exact:true}).waitFor();
    await page.screenshot({path:'/tmp/idea-scope-matrix.png'});
    await picker.getByRole('button',{name:'确定范围 · 2 个任务',exact:true}).click();
    await picker.waitFor({state:'hidden'});
    await dialog.getByRole('button',{name:'保存灵感',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    assert.equal(writes.length,1);assert.equal(writes[0].development_tasks.length,2);
    assert.equal(writes[0].development_tasks[0].models.length,3);
    assert.deepEqual(writes[0].development_tasks[0].models.map(row=>row.brand),['TENET','TENET','HAVAL']);
    await page.locator('.idea-card').getByText('TENET 脚垫安排',{exact:true}).waitFor();
    await page.locator('.idea-card').getByRole('button',{name:'认领任务'}).waitFor();
    await page.locator('.idea-card').getByRole('button',{name:'查看任务',exact:true}).click();
    const linked=page.getByRole('dialog',{name:'灵感关联的开发任务',exact:true});
    await linked.getByRole('button',{name:'编辑任务',exact:true}).first().click();
    const taskConfig=page.locator('.development-config-dialog');
    await taskConfig.getByText('TENET · 汽车脚垫 · T4',{exact:true}).waitFor();
    await taskConfig.getByText('HAVAL · 汽车脚垫 · H6',{exact:true}).waitFor();
    assert.equal(await taskConfig.locator('.model-table tbody tr').count(),3);
    await taskConfig.getByRole('button',{name:'取消',exact:true}).click();
    await taskConfig.waitFor({state:'hidden'});
    await linked.getByRole('button',{name:'Close this dialog'}).click();
    await page.locator('.idea-card').getByRole('button',{name:'编辑',exact:true}).click();
    const edit=page.getByRole('dialog',{name:'编辑灵感',exact:true});
    await edit.getByRole('button',{name:'打开开发坐标表 · 多选类目和车型'}).click();
    await picker.getByText('已选 3 个范围 · 2 个任务 · 40 个 SKU',{exact:true}).waitFor();
    await picker.getByRole('checkbox',{name:'勾选 HAVAL 汽车脚垫',exact:true}).locator('xpath=ancestor::label').click();
    await picker.getByRole('button',{name:'按品牌＋类目拆分',exact:true}).click();
    await picker.getByText('已选 3 个范围 · 3 个任务 · 40 个 SKU',{exact:true}).waitFor();
    await picker.getByRole('button',{name:'＋ 新增品牌',exact:true}).click();
    const brandDialog=page.getByRole('dialog',{name:'新增汽车品牌',exact:true});
    await brandDialog.getByPlaceholder('例如：PROTON').fill('proton');
    await brandDialog.getByRole('button',{name:'保存到目录',exact:true}).click();
    await brandDialog.waitFor({state:'hidden'});
    assert.equal(catalogWrites.at(-1).brand,'PROTON');
    await picker.getByRole('button',{name:'＋ 添加车型',exact:true}).click();
    const modelDialog=page.getByRole('dialog',{name:'新增车型',exact:true});
    await modelDialog.getByPlaceholder('例如：X70').fill('X70');
    await modelDialog.getByRole('button',{name:'保存到目录',exact:true}).click();
    await modelDialog.waitFor({state:'hidden'});
    await addCell('PROTON','汽车脚垫',['X70']);
    await picker.getByRole('button',{name:'＋ 新增类目',exact:true}).click();
    const categoryDialog=page.getByRole('dialog',{name:'新增开发类目',exact:true});
    await categoryDialog.getByPlaceholder('例如：门槛条').fill('门槛条');
    await categoryDialog.getByRole('button',{name:'保存到目录',exact:true}).click();
    await categoryDialog.waitFor({state:'hidden'});
    await picker.getByRole('button',{name:'PROTON · 门槛条，选择车型',exact:true}).waitFor();
    await picker.getByRole('button',{name:'＋ 新增类目',exact:true}).click();
    await categoryDialog.getByPlaceholder('例如：门槛条').fill('待审类目');
    await categoryDialog.getByRole('button',{name:'保存到目录',exact:true}).click();
    await categoryDialog.waitFor({state:'hidden'});
    await page.getByText('类目已提交审核，请经理或管理员在库存建品的标准选项中审核，通过后可选择',{exact:true}).waitFor();
    assert.equal(await picker.getByRole('button',{name:'PROTON · 待审类目，选择车型',exact:true}).count(),0);
    await picker.getByRole('button',{name:'确定范围 · 4 个任务',exact:true}).click();
    await picker.waitFor({state:'hidden'});
    await edit.getByRole('button',{name:'打开开发坐标表 · 多选类目和车型'}).click();
    await picker.getByRole('button',{name:'PROTON · 汽车脚垫，选择车型',exact:true}).waitFor();
    await picker.getByRole('button',{name:'＋ 新增品牌',exact:true}).hover();
    await page.screenshot({path:'/tmp/idea-catalog-additions.png',animations:'disabled'});
    assert.deepEqual(errors,[]);
  } finally { await browser?.close();await server.close(); }
});

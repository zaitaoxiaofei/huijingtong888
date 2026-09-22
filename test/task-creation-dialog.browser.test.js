import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

// Opt in: starts only a fixture frontend on the dedicated local test port.
// No real API or database is contacted.
test("task creation and editing work through the brand/category matrix", { skip: process.env.RUN_TASK_BROWSER_TESTS !== "1" }, async () => {
  const entry = `import { createApp, h, ref } from 'vue';
    import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
    import Dialog from '/frontend/admin/components/team/TaskCreationDialog.vue';
    const people = [{id:7,name:'测试负责人'}];
    const tasks = [{id:77,type:'procurement_daily',automation_key:'procurement_daily:2026-09-16',title:'每日采购任务',due_at:'2026-09-16',owner_name:'测试负责人'},
      {id:78,type:'shipping_daily',automation_key:'shipping_daily:2026-09-16',title:'每日发货任务',due_at:'2026-09-16'}];
    createApp({ setup() { const initial = ref(null); const key = ref(0); const visible = ref(true);
      window.openTaskFixture = value => { initial.value = value; key.value++; visible.value = true; };
      return () => h('div', { style:'min-height:100vh;background:#f1f5f9;font-family:Arial,sans-serif' }, visible.value ? h(Dialog, { key:key.value, people, tasks, initialTask:initial.value,
        onClose:() => visible.value=false, onSaved:() => { window.saved=true; visible.value=false; } }) : '任务已保存');
    }}).use(ElementPlus).mount('#app');`;
  const server = await createServer({ configFile: false, root: process.cwd(), optimizeDeps: { include: ["vue", "element-plus", "lucide-vue-next"] }, server: { host: "127.0.0.1", port: 8788, strictPort: true }, plugins: [vue(), {
    name: "task-dialog-test-fixture",
    resolveId(id) { if (id === "virtual:task-dialog-fixture") return '\0task-dialog-fixture'; },
    load(id) { if (id === '\0task-dialog-fixture') return entry; },
    configureServer(server) { server.middlewares.use('/admin.html', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/admin.html', '<html><body style="margin:0"><div id="app"></div><script type="module" src="/@id/virtual:task-dialog-fixture"></script></body></html>'));
    }); }
  }] });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1450, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const writes = [];
    let procurementTerm = '2026-09-15'; let termExpired = 1;
    await page.route('**/api/**', async route => {
      const req = route.request(); const url = new URL(req.url());
      let response;
      if (url.pathname === '/api/ai-variant-lab/vehicle-catalog') response = { brands: [
        {name:'TENET',tags:['priority_brand'],models:[{id:1,name:'T4',tags:[]},{id:2,name:'T7',tags:['top_priority_model']},{id:3,name:'T8',tags:[]}]},
        {name:'HAVAL',tags:[],models:[{id:4,name:'JOLION',tags:[]}]},
        {name:'GEELY',tags:[],models:[{id:5,name:'MONJARO',tags:[]}]}] };
      else if (url.pathname === '/api/inventory-product-naming/options') response = { rows: ['汽车钥匙保护壳','汽车脚垫','方向盘套'].map(value => ({value})) };
      else if (url.pathname === '/api/team/operational-owners' && req.method() === 'GET') response = {rows:[{type:'procurement_daily',owner_person_id:7,owner_name:'测试负责人',term_until:procurementTerm,term_expired:termExpired}]};
      else if (url.pathname === '/api/listing/drafts') response = { rows: [{id:101,product_name:'TENET T4 钥匙壳',created_at:'2026-09-16T04:00:00Z'}], total:1 };
      else if (req.method() === 'POST' || req.method() === 'PUT') { writes.push(req.postDataJSON()); response = {ok:true,id:55}; }
      else throw new Error(`Unexpected API: ${url.pathname}`);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
    });
    await page.goto('http://127.0.0.1:8788/admin.html#/team-plan');
    await page.getByRole('button', { name: /开发产品.*已选择/ }).waitFor();
    await page.getByRole('button',{name:/采购任务.*负责人：测试负责人.*已到期，待确认/}).waitFor();
    await page.screenshot({ path:'/tmp/task-creation-types.png' });
    await page.getByRole('button', {name:'下一步'}).click();
    await page.getByRole('button', {name:'TENET · 汽车钥匙保护壳，配置开发任务'}).waitFor();
    await page.screenshot({path:'/tmp/task-creation-matrix.png'});
    await page.getByRole('button', {name:'TENET · 汽车钥匙保护壳，配置开发任务'}).click();
    const config = page.getByRole('dialog', {name:'TENET · 汽车钥匙保护壳'});
    await config.getByText('T4',{exact:true}).click();
    await config.getByText('T7',{exact:true}).click();
    const t7 = config.locator('tbody tr').filter({has:page.getByRole('checkbox',{name:'T7',exact:true})});
    await t7.getByRole('spinbutton').fill('20');
    await t7.getByRole('spinbutton').press('Tab');
    await config.getByRole('button',{name:'创建任务 · 30 个 SKU'}).click();
    await page.getByText('请选择任务负责人',{exact:true}).waitFor();
    assert.equal(writes.length,0);
    await config.locator('.el-select').click();
    await page.getByRole('option',{name:'测试负责人'}).click();
    await config.getByPlaceholder('选择日期').fill('2026-09-30');
    await config.getByPlaceholder('选择日期').press('Enter');
    await config.getByPlaceholder('例如：颜色、材质、款式或验收要求').fill('每个车型包含黑色款式');
    await config.getByText('完成标准',{exact:true}).click();
    await page.locator('.el-message').waitFor({state:'hidden'});
    await page.screenshot({path:'/tmp/task-creation-models.png'});
    await config.getByRole('button',{name:'创建任务 · 30 个 SKU'}).click();
    await page.waitForFunction(() => window.saved === true);
    assert.equal(writes.length,1);
    const payload = writes[0];
    assert.equal(payload.type,'product_development');
    assert.equal(payload.related.models.length,2);
    assert.equal(payload.related.models.find(row=>row.model==='T7').target,20);
    assert.equal(payload.due_at,'2026-09-30');
    await page.evaluate(payload => window.openTaskFixture({id:55,...payload,development_plan:{...payload.related,models:payload.related.models.map(row=>({...row,done:0,drafts:[]}))}}),payload);
    await config.getByText('T4',{exact:true}).waitFor();
    await config.locator('tbody tr').filter({has:page.getByRole('checkbox',{name:'T4',exact:true})}).getByRole('button',{name:'关联草稿（0）'}).click();
    const drafts = page.getByRole('dialog',{name:'TENET · 汽车钥匙保护壳 · T4 · 关联成果草稿'});
    await drafts.locator('.el-checkbox__inner').click();
    await drafts.getByRole('button',{name:'完成选择，返回任务'}).click();
    await config.getByRole('button',{name:'保存任务',exact:true}).click();
    await page.waitForFunction(() => document.body.textContent.includes('任务已保存'));
    assert.deepEqual(writes[1].related.models.find(row=>row.model==='T4').draft_ids,[101]);
    await page.evaluate(() => window.openTaskFixture(null));
    await page.getByRole('button',{name:/采购任务.*选择类型/}).click();
    await page.getByRole('button',{name:'下一步'}).click();
    await page.getByText('当前固定负责人：测试负责人').waitFor();
    await page.getByText('负责期限已到期，请重新确认负责人和截止日期；未确认前继续由原负责人负责。').waitFor();
    await page.getByRole('button',{name:'从今天起一个月'}).click();
    const monthDate = await page.getByPlaceholder('不设期限，长期负责').inputValue();
    assert.match(monthDate, /^\d{4}-\d{2}-\d{2}$/);
    await page.getByRole('button',{name:'保存固定负责人'}).click();
    await page.waitForFunction(() => document.body.textContent.includes('任务已保存'));
    assert.deepEqual(writes[2],{type:'procurement_daily',owner_person_id:7,term_until:monthDate});
    procurementTerm=monthDate; termExpired=0;
    await page.evaluate(() => window.openTaskFixture(null));
    await page.getByRole('button',{name:/采购任务.*负责人：测试负责人.*负责至/}).waitFor();
    await page.getByRole('button',{name:/每日发货.*选择类型/}).click();
    await page.getByRole('button',{name:'下一步'}).click();
    await page.getByText('当前固定负责人：尚未设置').waitFor();
    await page.getByRole('button',{name:'保存固定负责人'}).click();
    await page.getByText('请选择固定负责人',{exact:true}).waitFor();
    assert.equal(writes.length,3);
    await page.getByRole('dialog',{name:'新增任务'}).locator('.el-select').click();
    await page.getByRole('option',{name:'测试负责人'}).click();
    await page.screenshot({path:'/tmp/task-fixed-owner.png'});
    await page.getByRole('button',{name:'保存固定负责人'}).click();
    await page.waitForFunction(() => document.body.textContent.includes('任务已保存'));
    assert.deepEqual(writes[3],{type:'shipping_daily',owner_person_id:7,term_until:null});
    await page.evaluate(() => { window.saved=false; window.openTaskFixture(null); });
    await page.getByRole('button',{name:'下一步'}).click();
    await page.locator('.matrix-search .el-select').click();
    await page.getByRole('option',{name:'非汽车',exact:true}).click();
    await page.getByRole('button',{name:'非汽车 · 汽车钥匙保护壳，配置开发任务'}).click();
    const nonCar = page.getByRole('dialog',{name:'非汽车 · 汽车钥匙保护壳',exact:true});
    await nonCar.locator('.el-select').click();
    await page.getByRole('option',{name:'测试负责人'}).click();
    await nonCar.getByPlaceholder('选择日期').fill('2026-09-30');
    await nonCar.getByPlaceholder('选择日期').press('Enter');
    await nonCar.getByRole('button',{name:'创建任务 · 10 个 SKU'}).click();
    await page.waitForFunction(() => window.saved === true);
    assert.equal(writes.at(-1).related.scope,'non_automotive');
    assert.equal(writes.at(-1).related.models[0].model_id,0);
    await page.evaluate(() => {
      window.saved=false;
      window.openTaskFixture({id:80,source_idea_id:12,title:'合并开发',owner_person_id:7,due_at:'2026-09-30',development_plan:{kind:'development_matrix',brand:'TENET',category:'汽车钥匙保护壳',source_idea_id:12,group_key:'group-a',
        models:[{brand:'TENET',category:'汽车钥匙保护壳',scope:'automotive',model_id:1,model:'T4',target:10,done:0,drafts:[],draft_ids:[]},{brand:'HAVAL',category:'汽车脚垫',scope:'automotive',model_id:4,model:'JOLION',target:5,done:0,drafts:[],draft_ids:[]}],
        unallocated_draft_ids:[101],unallocated_drafts:[{id:101,title:'历史成果',count:3}]}});
    });
    const merged = page.getByRole('dialog',{name:'编辑灵感开发任务',exact:true});
    await merged.getByText('历史成果待分配（1 份）',{exact:true}).waitFor();
    await merged.locator('.completion-rule .el-select').click();
    await page.getByRole('option',{name:'HAVAL · 汽车脚垫 · JOLION',exact:true}).click();
    await merged.getByRole('button',{name:'分配到所选车型',exact:true}).click();
    await merged.getByRole('button',{name:'保存任务',exact:true}).click();
    await page.waitForFunction(() => window.saved === true);
    const assigned = writes.at(-1).related;
    assert.deepEqual(assigned.unallocated_draft_ids,[]);
    assert.deepEqual(assigned.models.find(row=>row.brand==='HAVAL').draft_ids,[101]);
    assert.deepEqual(assigned.models.find(row=>row.brand==='TENET').draft_ids,[]);
    assert.deepEqual(errors,[]);
  } finally { await browser?.close(); await server.close(); }
});

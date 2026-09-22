import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright-core";

// Isolated UI fixtures on the dedicated test port; all API calls are intercepted.
test("inventory applicants submit once and managers review the complete saved form", { skip: process.env.RUN_INVENTORY_REQUEST_BROWSER_TESTS !== "1" }, async () => {
  const payload = { owner_person_id: 7, name: "门槛贴纸 通用 黑色 普通款 PVC 2个", image_url: "", purchase_url: "https://example.com/buy", purchase_cost: 15, structured_naming: { category: "门槛贴纸", vehicle_brand: "", vehicle_models: [], accessory: "普通款", colors: ["黑色"], materials: ["PVC"], quantity: 2, stock_unit: "个" } };
  const entry = `import { createApp, h, ref } from 'vue';
    import { createPinia } from 'pinia'; import { createRouter, createMemoryHistory } from 'vue-router';
    import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css';
    import ProductDialog from '/frontend/admin/components/inventory/ProductCreateEditDialog.vue';
    import Requests from '/frontend/admin/components/inventory/InventoryProductRequestsDialog.vue';
    import { useAuthStore } from '/frontend/admin/stores/auth.js';
    const people = [{id:7,name:'录入员'},{id:8,name:'库存经理'}]; const payload = ${JSON.stringify(payload)};
    const app = createApp({setup() {
      const auth=useAuthStore(); auth.user={personId:7,name:'录入员',role:'operator'};
      const mode=ref('create'); const visible=ref(true);
      window.openReviewFixture = () => {auth.user={personId:8,name:'库存经理',role:'packing',roles:['packing','manager']}; mode.value='review'; visible.value=true;};
      window.openApplicantFixture = () => {auth.user={personId:7,name:'录入员',role:'operator'}; mode.value='requests'; visible.value=true;};
      return () => mode.value === 'create' ? h(ProductDialog,{visible:visible.value,target:'inventory',value:payload,people,
        'onUpdate:visible':value=>visible.value=value,onSaved:()=>window.saved=true,onSubmitted:value=>window.submitted=value})
        : visible.value ? h(Requests,{people,onClose:()=>visible.value=false,onChanged:()=>window.changed=true}) : null;
    }}); app.use(createPinia()); app.use(createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]})); app.use(ElementPlus); app.mount('#app');`;
  const server = await createServer({ configFile: false, root: process.cwd(), optimizeDeps: { include: ["vue", "element-plus", "pinia", "vue-router"] }, server: { host: "127.0.0.1", port: 8788, strictPort: true, watch: { ignored: ["**/.deploy-artifacts/**", "**/public/**", "**/dist/**"] } }, plugins: [vue(), {
    name: "inventory-request-fixture",
    resolveId(id) { if (id === "virtual:inventory-request-fixture") return '\0inventory-request-fixture'; },
    load(id) { if (id === '\0inventory-request-fixture') return entry; },
    configureServer(server) { server.middlewares.use('/admin.html', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/admin.html', '<html><body><div id="app"></div><script type="module" src="/@id/virtual:inventory-request-fixture"></script></body></html>'));
    }); }
  }] });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(15000);
    const errors = [], writes = [];
    let requestStatus = 'pending', revision = 1, storedPayload = payload;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req=route.request(), url=new URL(req.url());
      if (!url.pathname.startsWith("/api/")) return route.continue();
      let response = [];
      if (url.pathname === '/api/inventory-product-naming/options') {
        const values = {category:['钥匙壳'],accessory:['普通款'],color:['黑色'],material:['PVC'],process:[],quantity:['1','2'],brand:[]};
        response={rows:(values[url.searchParams.get('type')] || []).map((value,index)=>({id:index+1,value,label:value,status:'active'}))};
      } else if (url.pathname === '/api/ai-variant-lab/vehicle-catalog') response = {brands:[{name:'TOYOTA',models:[{name:'Corolla'}]}]};
      else if (url.pathname === '/api/products' && req.method()==='POST') {
        storedPayload=req.postDataJSON(); writes.push({url:url.pathname,body:storedPayload}); response={status:'pending',request_id:1};
      } else if (url.pathname === '/api/inventory-product-requests') response={rows:[{id:1,applicant_id:7,applicant_name:'录入员',name:storedPayload.name,status:requestStatus,revision,created_at:'2026-09-16T02:00:00Z',new_options:[{type:'category',label:'核心品名',value:'门槛贴纸'}],review_note:requestStatus==='returned'?'补充主图':''}],total:1,can_review:await page.evaluate(()=>window.reviewMode===true)};
      else if (url.pathname === '/api/inventory-product-requests/1' && req.method()==='GET') response={id:1,revision,payload:storedPayload,status:requestStatus};
      else if (url.pathname === '/api/inventory-product-requests/1' && req.method()==='PUT') {
        const body=req.postDataJSON(); writes.push({url:url.pathname,body});
        requestStatus=body.action==='approve'?'approved':body.action==='resubmit'?'pending':'returned'; revision++;
        if (body.payload) storedPayload=body.payload;
        response={status:requestStatus,request_id:1,product_id:requestStatus==='approved'?77:null,binding_status:'none'};
      } else if (req.method()!=='GET') writes.push({url:url.pathname,body:req.postDataJSON()});
      await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
    });
    await page.goto('http://127.0.0.1:8788/admin.html#/inventory-products');
    try { await page.getByRole('button',{name:'提交审核并建品',exact:true}).waitFor(); } catch (error) { console.log({errors, text:await page.locator('body').innerText()}); throw error; }
    assert.equal(await page.locator('.el-alert').filter({hasText:'新增选项，待审核'}).count(),1);
    assert.equal(writes.length,0);
    const coreInput = page.locator('.el-form-item').filter({hasText:'核心品名'}).locator('input').first();
    await coreInput.fill('门槛条贴纸');
    await coreInput.press('Enter');
    await page.getByRole('button',{name:'提交审核并建品',exact:true}).click();
    await page.waitForFunction(()=>window.submitted?.request_id===1);
    assert.equal(await page.evaluate(()=>Boolean(window.saved)),false);
    assert.equal(writes.length,1);
    assert.equal(writes[0].body.structured_naming.category,'门槛条贴纸');
    assert.equal(writes[0].body.purchase_url,payload.purchase_url);
    assert.ok(writes[0].body.request_key);
    await page.evaluate(()=>{window.reviewMode=true;window.openReviewFixture();});
    await page.getByRole('button',{name:'退回',exact:true}).click();
    await page.locator('.el-message-box textarea').fill('补充采购说明');
    await page.locator('.el-message-box').getByRole('button',{name:'退回',exact:true}).click();
    await page.getByText('已退回，原建品信息已保留').waitFor();
    await page.evaluate(()=>{window.reviewMode=false;window.openApplicantFixture();});
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.getByRole('button',{name:'修改并重提',exact:true}).click();
    await page.getByRole('button',{name:'重新提交审核',exact:true}).click();
    await page.getByRole('button',{name:'重新提交审核',exact:true}).waitFor({state:'hidden'});
    assert.equal(writes.at(-1).body.action,'resubmit');
    assert.equal(writes.at(-1).body.payload.purchase_url,payload.purchase_url);
    await page.evaluate(()=>{window.reviewMode=true;window.openReviewFixture();});
    await page.getByRole('button',{name:'刷新',exact:true}).click();
    await page.getByRole('button',{name:'查看并审核',exact:true}).click();
    await page.getByRole('button',{name:'通过并创建库存',exact:true}).waitFor();
    await page.waitForFunction(() => !document.querySelector('.dialog-fade-enter-active'));
    await page.screenshot({path:'/tmp/inventory-request-review.png'});
    assert.equal(await page.locator('.el-form-item').filter({hasText:'核心品名'}).locator('input').first().inputValue(),'');
    assert.ok((await page.locator('.standard-name-preview').innerText()).includes('门槛条贴纸'));
    await page.getByRole('button',{name:'通过并创建库存',exact:true}).click();
    await page.getByRole('button',{name:'通过并创建库存',exact:true}).waitFor({state:'hidden'});
    assert.equal(writes.at(-1).body.action,'approve');
    assert.equal(writes.at(-1).body.payload.structured_naming.quantity,2);
    assert.equal(writes.at(-1).body.payload.purchase_url,payload.purchase_url);
    assert.deepEqual(errors,[]);
  } finally { if(browser) await browser.close(); await server.close(); }
});

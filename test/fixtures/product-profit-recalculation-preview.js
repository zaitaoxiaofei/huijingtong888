import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const shell = `<script setup>
import {ref} from 'vue';
import ProductProfitRecalculationDialog from '/frontend/admin/components/inventory/ProductProfitRecalculationDialog.vue';
import ProductCreateEditDialog from '/frontend/admin/components/inventory/ProductCreateEditDialog.vue';
const review=ref(),editorVisible=ref(false),product=ref({id:1041,code:'P-20261113-144333-001',name:'EVOLUTE i-JOY 门槛条',inventory_number:'1-1041',product_type:'main',selection_status:'listed',purchase_cost:27,package_weight_g:0,length_cm:30,width_cm:20,height_cm:10,logistics_rule_id:70,shipping_method:'economy',withdrawal_fee_rate:0.012,payment_fee_rate:0.013,return_rate:0.05,exchange_rate:12.4009,owner_person_id:7,stock_unit:'套',product_quantity:1,package_mode:'set',purchase_quantity:1,handling_fee:0,domestic_shipping:0,advertising_rate:0,vehicle_brand:'EVOLUTE',vehicle_model:'i-JOY',fitment_type:'specific',inventory_category:'门槛条',accessory_name:'门槛条',structured_naming:{category:'门槛条',vehicle_brand:'EVOLUTE',fitment_type:'specific',vehicle_model:'i-JOY',vehicle_models:['i-JOY'],accessory:'门槛条',quantity:1,stock_unit:'套',package_mode:'set',colors:[],materials:[]}});
const rules=[{id:70,name:'OGL 陆运 Extra Small',carrier:'OGL',channel:'economy',mode:'per_gram',enabled:1,min_weight_g:1,max_weight_g:500,min_price_rub:1,max_price_rub:1500,per_gram_cny:0.0242,per_ticket_cny:2.8,effective_from:'2026-10-19T16:00:00Z'}];
async function reviewWeight(){await review.value.open({...product.value,package_weight_g:300},[{key:'package_weight_g',label:'包裹重量（克）',before:0,after:300}]);}
async function reviewTariff(){await review.value.open(product.value,[{key:'logistics_rule_id',label:'物流运价规则',before:62,after:70}]);}
window.fixtureProduct=product;
</script><template><main style="padding:32px;max-width:1100px;margin:auto"><p style="color:#60a5fa">本地验收 · 演示数据 · 不连接生产</p><h1>订单利润重算</h1><p>订单 0112339342-0272-1 · EVOLUTE i-JOY 门槛条 · 售价 ¥100</p><el-space wrap><el-button type="primary" @click="reviewWeight">查看重量修正后的提示</el-button><el-button @click="reviewTariff">查看物流切换后的提示</el-button><el-button @click="editorVisible=true">编辑库存商品</el-button></el-space><p>重量修正预览：运费 5.04 → 12.06 元，利润 50.70 → 43.77 元。</p><ProductProfitRecalculationDialog ref="review"/><ProductCreateEditDialog v-if="editorVisible" v-model:visible="editorVisible" mode="edit" target="inventory" :value="product" :edit-product-id="1041" :people="[{id:7,name:'测试采购'}]" :suppliers="[]" :logistics-rules="rules" @saved="value=>{product=value.product;editorVisible=false}"/></main></template>`;
const entry = `import {createApp} from 'vue';import {createPinia} from 'pinia';import {createRouter,createWebHashHistory} from 'vue-router';import ElementPlus from 'element-plus';import 'element-plus/dist/index.css';import '/frontend/admin/styles/index.css';import '/frontend/admin/styles/erp-theme.css';import Shell from '/__profit/Shell.vue';import {useAuthStore} from '/frontend/admin/stores/auth.js';import {setAuthToken} from '/frontend/admin/utils/api.js';const app=createApp(Shell),pinia=createPinia();app.use(pinia).use(ElementPlus);const user={id:7,personId:7,name:'本地测试采购',role:'procurement',roles:['procurement'],tenant:{id:2,slug:'a',role:'member'},business_roles:['procurement']};useAuthStore().user=user;setAuthToken('local-profit-fixture');localStorage.setItem('baodanAuthUser',JSON.stringify(user));app.use(createRouter({history:createWebHashHistory(),routes:[{path:'/:pathMatch(.*)*',component:{template:'<span/>'}}]}));window.fixtureErrors=[];app.config.errorHandler=e=>window.fixtureErrors.push(e.message);app.mount('#adminApp');`;
export async function startProductProfitPreview({ host = '::1' } = {}) {
  const calls = [];
  const server = await createServer({ configFile: false, root: process.cwd(), publicDir: false,
    cacheDir: await mkdtemp(path.join(tmpdir(), 'profit-preview-vite-')), logLevel: 'error',
    server: { host, port: 8788, strictPort: true }, plugins: [vue(), {
      name: 'profit-recalculation-fixture', resolveId(id) { if (id.startsWith('/__profit/')) return id; },
      load(id) { return { '/__profit/Shell.vue': shell, '/__profit/entry.js': entry }[id]; },
      configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        const send = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
        if (url.pathname === '/admin.html') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="adminApp"></div><script type="module" src="/__profit/entry.js"></script></body></html>'); return; }
        if (url.pathname === '/__fixture/state') return send({ calls });
        if (!url.pathname.startsWith('/api/')) return next();
        let body = {}; if (['POST','PUT'].includes(req.method)) { let data=''; for await (const part of req) data+=part; body=JSON.parse(data||'{}'); }
        calls.push({ path:url.pathname, method:req.method, body });
        if (url.pathname.endsWith('/recalculate-profits')) return send(body.preview ? {
          preview: true, preview_token: 'fixture-preview', selected_items: 1, skipped_items: 1, profit_difference: -6.93,
          rows: [{ order_item_id:35793,posting_number:'0112339342-0272-1',weight_g:300,logistics_rule_id:70,logistics_rule_name:'OGL 陆运 Extra Small',formula_version:'V4',old_freight:5.04,new_freight:12.06,old_profit:50.70,new_profit:43.77 }],
          skipped_rows:[{order_item_id:35794,posting_number:'已结算订单示例',reason:'已结算或锁定'}]
        } : { ok:true,updated:1,skipped:1,failed:0 });
        if (url.pathname === '/api/products/1041' && req.method === 'PUT') return send({ ok:true,product:{...body,id:1041} });
        if (url.pathname === '/api/logistics-rules') return send([{ id:70,name:'OGL 陆运 Extra Small',effective_from:'2026-10-19T16:00:00Z' }]);
        if (url.pathname === '/api/inventory/naming-options') return send({});
        if (url.pathname.includes('vehicle')) return send({ brands:[],models:[],rows:[] });
        return send({ rows:[],total:0 });
      }); }
    }] });
  await server.listen(); return { server, calls };
}
if (process.argv[1]?.endsWith('product-profit-recalculation-preview.js')) { await startProductProfitPreview(); console.log('Local fixture: http://[::1]:8788/admin.html#/inventory/products'); }

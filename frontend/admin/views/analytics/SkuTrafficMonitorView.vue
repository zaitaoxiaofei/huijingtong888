<script setup>
import {computed,onMounted,onBeforeUnmount,reactive,ref} from 'vue';
import {ElMessage} from 'element-plus';
import {Refresh,Search} from '@element-plus/icons-vue';
import ErpPageHeader from '../../components/ErpPageHeader.vue';
import ErpFilterBar from '../../components/ErpFilterBar.vue';
import PageFooterPagination from '../../components/PageFooterPagination.vue';
import SkuTrafficChart from '../../components/SkuTrafficChart.vue';
import {getSkuTrafficDaily,collectSkuTrafficDaily} from '../../api/sellerAnalytics';
import {shanghaiDateTimeText} from '../../utils/shanghai-date';
import {createDailyTrafficMonitor} from '../../utils/sku-traffic-monitor-pump';
const state=reactive({rows:[],shops:[],days:[],coverage:[],total:0,date:'',shop_id:'all',query:'',page:1,pageSize:30});
const loading=ref(false),queuing=ref(false),error=ref(''),active=ref(null),detailVisible=ref(false),chartGroup=ref('traffic');
let revision=0,disposed=false;
const metrics=[['total_views','总曝光'],['search_views','搜索曝光'],['pdp_views','详情浏览'],['total_hits_to_cart','加购次数'],['ordered_units','下单件数']];
const rates=[['conv_views_to_order','曝光至下单'],['conv_total_views_to_cart','曝光至加购'],['conv_hits_to_cart_to_order','加购至下单']];
const number=value=>value===null||value===undefined?'—':Number(value).toLocaleString();
const percent=value=>value===null||value===undefined?'—':`${Number(value).toFixed(2)}%`;
const changed=row=>{const a=row.selected?.total_views,b=row.previous?.total_views;if(a===null||a===undefined||b===null||b===undefined||!Number(b))return '—';const change=(Number(a)-Number(b))/Number(b)*100;return `${change>0?'+':''}${change.toFixed(1)}%`;};
const coverage=computed(()=>state.shops.map(shop=>{const day=state.coverage.find(d=>d.shop_id===shop.id&&d.date_key===state.date);return{...shop,...day,status:error.value?'unavailable':day?.status||'missing'};}));
const statusLabel={unavailable:'读取失败',complete:'完整',pending:'等待采集',partial:'未覆盖全店',failed:'采集失败',missing:'未采集'};
const totalComplete=computed(()=>coverage.value.filter(s=>s.status==='complete').length);
async function load(reset=false){
 if(reset)state.page=1;
 const ticket=++revision;loading.value=true;error.value='';
 try{const data=await getSkuTrafficDaily({date:state.date,shop_id:state.shop_id,query:state.query,page:state.page,pageSize:state.pageSize});if(ticket!==revision||disposed)return;Object.assign(state,{rows:data.rows||[],shops:data.shops||[],days:data.days||[],coverage:data.coverage||[],total:data.total||0,date:data.date||state.date});}
 catch(e){if(ticket===revision&&!disposed){error.value=e.message||'日数据读取失败';state.rows=[];}}
 finally{if(ticket===revision&&!disposed)loading.value=false;}
}
async function collect(selectedDate=false){
 queuing.value=true;
 try{const response=await collectSkuTrafficDaily({shop_id:state.shop_id,...(selectedDate?{date:state.date}:{})});const data=response.data||response;ElMessage.success(`已排队 ${data.queued?.length||0} 个店铺日，另有 ${data.waiting?.length||0} 个等待插件；排队不代表已完成`);wakeCollector();await load();}
 catch(e){ElMessage.error(e.message||'采集排队失败');}
 finally{queuing.value=false;}
}
function wakeCollector(){
 const shop=state.shops.find(s=>String(s.id)===String(state.shop_id));
 window.postMessage({type:'BAODAN_ANALYTICS_PLUGIN_WAKE',expectedStoreId:shop?.store_id||''},window.location.origin);
}
const monitor=createDailyTrafficMonitor({refresh:()=>load(),busy:()=>loading.value||queuing.value,wake:()=>{if(!error.value&&state.coverage.some(day=>day.status==='pending'))wakeCollector();}});
function open(row){active.value=row;detailVisible.value=true;}
onMounted(()=>monitor.start());onBeforeUnmount(()=>{disposed=true;revision++;monitor.stop();});
</script>
<template>
 <div class="sku-traffic-monitor">
  <ErpPageHeader title="SKU 流量监控" description="观察最近15个完整报表日的曝光、浏览、加购与下单变化">
   <template #actions><el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button><el-button :loading="queuing" @click="collect(true)">补采选定日</el-button><el-button type="primary" :loading="queuing" @click="collect(false)">同步日数据</el-button></template>
  </ErpPageHeader>
  <div class="traffic-summary"><div><strong>{{error?'—':`${totalComplete} / ${state.shops.length}`}}</strong><span>选定日店铺数据完整</span></div><div><strong>{{error?'—':state.total.toLocaleString()}}</strong><span>近15天有记录的SKU</span></div><div><strong>1 天 / 15 天</strong><span>临时原始页 / 正式日指标保留</span></div></div>
  <ErpFilterBar>
   <el-select v-model="state.shop_id" aria-label="店铺" @change="load(true)"><el-option label="全部店铺" value="all"/><el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)"/></el-select>
   <el-select v-model="state.date" aria-label="报表日期" @change="load(true)"><el-option v-for="day in [...state.days].reverse()" :key="day" :label="day" :value="day"/></el-select>
   <el-input v-model="state.query" placeholder="搜索SKU、货号或商品名称" clearable @keyup.enter="load(true)" @clear="load(true)"/>
   <el-button :icon="Search" @click="load(true)">查询</el-button>
  </ErpFilterBar>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <p class="traffic-note">插件及对应店铺的登录页面在线后执行。“未覆盖全店”表示仅展示已采到的SKU，不能作为全店总量。空缺表示尚无数据，不计为0；详情浏览不等于广告点击，下单件数不等于订单数。转化率沿用官方报表口径。</p>
  <div class="shop-coverage"><el-tooltip v-for="shop in coverage" :key="shop.id" :content="shop.message||`${shop.last_success_at?'最近完整更新：'+shanghaiDateTimeText(shop.last_success_at):'尚无完整日数据'}${shop.product_count!==null&&shop.product_count!==undefined?'；SKU '+shop.product_count:''}`"><el-tag :type="shop.status==='complete'?'success':shop.status==='pending'?'info':'warning'">{{shop.name}} · {{statusLabel[shop.status]||shop.status}}</el-tag></el-tooltip></div>
  <el-table v-loading="loading" :data="state.rows" :row-key="row=>`${row.shop_id}:${row.sku}`" @row-dblclick="open">
   <el-table-column label="商品" min-width="270"><template #default="{row}"><div class="traffic-product"><el-image v-if="row.image_url" :src="row.image_url" :preview-src-list="[row.image_url]" :initial-index="0" preview-teleported fit="cover"/><div v-else class="no-image">无图</div><div><div>{{row.product_name||'商品资料未同步'}}</div><small>{{row.shop_name}} · SKU {{row.sku}}</small><small v-if="row.offer_id">货号 {{row.offer_id}}</small></div></div></template></el-table-column>
   <el-table-column v-for="[key,label] in metrics" :key="key" :label="label" min-width="104" align="right"><template #default="{row}">{{number(row.selected?.[key])}}</template></el-table-column>
   <el-table-column label="曝光较前日" min-width="118" align="right"><template #default="{row}">{{changed(row)}}</template></el-table-column>
   <el-table-column label="15天曝光趋势" width="180"><template #default="{row}"><SkuTrafficChart :series="row.series" compact/></template></el-table-column>
   <el-table-column label="查看" width="80" fixed="right"><template #default="{row}"><el-button link type="primary" @click="open(row)">趋势</el-button></template></el-table-column>
   <template #empty><el-empty :description="error?'读取失败，请刷新重试':'尚无每日记录。点击同步日数据，插件在线后开始积累。'"/></template>
  </el-table>
  <PageFooterPagination v-if="!error" :page="state.page" :page-size="state.pageSize" :total="state.total" @update:page="state.page=$event;load()" @update:page-size="state.pageSize=$event;load(true)"/>
  <el-drawer v-model="detailVisible" title="SKU 每日流量趋势" size="min(1100px, 96vw)" destroy-on-close>
   <template v-if="active"><h3>{{active.product_name||active.sku}}</h3><p>{{active.shop_name}} · SKU {{active.sku}} · 曲线断点表示缺失，鼠标移到数据点查看日期和数值</p>
    <el-radio-group v-model="chartGroup"><el-radio-button value="traffic">流量与下单</el-radio-button><el-radio-button value="rates">转化率</el-radio-button></el-radio-group><div class="traffic-charts"><SkuTrafficChart v-for="[key,label] in (chartGroup==='traffic'?metrics:rates)" :key="key" :series="active.series" :metric="key" :label="label" :unit="chartGroup==='rates'?'%':''"/></div>
    <el-table :data="active.series" size="small"><el-table-column prop="date_key" label="日期" width="110"/><el-table-column v-for="[key,label] in metrics" :key="key" :label="label" min-width="100"><template #default="{row}">{{number(row[key])}}</template></el-table-column><el-table-column v-for="[key,label] in rates" :key="key" :label="label" min-width="120"><template #default="{row}">{{percent(row[key])}}</template></el-table-column></el-table>
   </template>
  </el-drawer>
 </div>
</template>
<style scoped>
.sku-traffic-monitor{display:flex;flex-direction:column;gap:14px;padding:16px}.traffic-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.traffic-summary>div{padding:18px;border:1px solid var(--erp-border-color,#e4e7ed);border-radius:12px;background:var(--erp-bg-card,#fff);display:flex;flex-direction:column;gap:8px}.traffic-summary strong{font-size:24px}.traffic-summary span,.traffic-note,small{color:var(--erp-text-secondary,#7b8497);font-size:12px}.traffic-note{margin:0;line-height:1.8}.shop-coverage{display:flex;gap:8px;flex-wrap:wrap}.traffic-product{display:flex;align-items:center;gap:12px;min-height:92px}.traffic-product .el-image,.no-image{width:64px;height:84px;flex-shrink:0;border-radius:6px}.no-image{display:grid;place-items:center;background:var(--erp-bg-page,#f1f4f8);color:var(--erp-text-secondary,#7b8497)}.traffic-product small{display:block;line-height:1.8}.traffic-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:18px 0}.sku-traffic-monitor :deep(.erp-filter-bar .el-select){width:190px}.sku-traffic-monitor :deep(.erp-filter-bar .el-input){width:260px}@media(max-width:800px){.traffic-summary,.traffic-charts{grid-template-columns:1fr}}
</style>

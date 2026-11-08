<script setup>
import {computed,onMounted,onBeforeUnmount,reactive,ref} from 'vue';
import {ElMessage} from 'element-plus';
import {Refresh,Search,Plus,Delete} from '@element-plus/icons-vue';
import ErpPageHeader from '../../components/ErpPageHeader.vue';
import PageFooterPagination from '../../components/PageFooterPagination.vue';
import SkuTrafficTrendChart from '../../components/SkuTrafficTrendChart.vue';
import {getSkuTrafficDaily,collectSkuTrafficDaily} from '../../api/sellerAnalytics';
import {createDailyTrafficMonitor} from '../../utils/sku-traffic-monitor-pump';
import {SKU_TRAFFIC_OPERATION_METRICS} from '../../../../src/shared/sku-traffic-monitor-query';
const state=reactive({rows:[],shops:[],days:[],coverage:[],total:0,date:'',latest_available_date:null,report_end_date:'',selected_count:0,range_from:'',shop_id:'all',page:1,pageSize:30});
const form=reactive({query:'',search_by:'all',exact:true,range_days:7,sort_key:'total_views',sort_order:'desc'});
const rules=ref([]),applied=ref({...form,filters:'[]'}),datePinned=ref(false);
const loading=ref(false),queuing=ref(false),error=ref(''),active=ref(null),chartGroup=ref('traffic');
const detail=ref(null),detailLoading=ref(false),detailError=ref('');
let revision=0,detailRevision=0,disposed=false;
const metricOptions=SKU_TRAFFIC_OPERATION_METRICS;
const metrics=metricOptions.slice(0,5),rates=metricOptions.slice(5,8);
const comparisons=[['gt','>'],['gte','≥'],['lt','<'],['lte','≤'],['eq','=']];
const number=value=>value===null||value===undefined?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:2});
const percent=value=>value===null||value===undefined?'—':`${Number(value).toFixed(2)}%`;
const shortName=name=>String(name||'商品资料未同步').length>42?String(name).slice(0,42)+'…':name||'商品资料未同步';
const inventoryLabel=row=>row.inventory?.map(p=>`${p.inventory_number||p.code||'#'+p.id} ${p.name}`).join('；')||'未关联库存';
const statusLabel={complete:'完整',pending:'等待采集',partial:'未覆盖全店',failed:'采集失败',missing:'未采集'};
const coverage=computed(()=>state.shops.map(shop=>({...shop,...state.coverage.find(d=>d.shop_id===shop.id&&d.date_key===state.date)})));
const chartSeries=computed(()=>detail.value?.series?.filter(day=>day.date_key>=state.range_from&&day.date_key<=state.date)||[]);
async function loadTrend(row){
 const ticket=++detailRevision;detail.value=null;detailError.value='';
 if(!row){detailLoading.value=false;return;}
 detailLoading.value=true;
 try{const data=await getSkuTrafficDaily({shop_id:row.shop_id,date:state.date,range_days:applied.value.range_days,query:row.sku,search_by:'sku',exact:1,include_series:1,pageSize:1});if(ticket===detailRevision&&!disposed)detail.value=data.rows?.[0]||null;}
 catch(e){if(ticket===detailRevision&&!disposed)detailError.value=e.message||'趋势读取失败';}
 finally{if(ticket===detailRevision&&!disposed)detailLoading.value=false;}
}
function selectProduct(row){active.value=row;void loadTrend(row);}
async function load(reset=false){
 if(reset)state.page=1;
 const ticket=++revision;loading.value=true;error.value='';
 try{
  const data=await getSkuTrafficDaily({...applied.value,date:datePinned.value?state.date:undefined,shop_id:state.shop_id,include_series:0,page:state.page,pageSize:state.pageSize});
  if(ticket!==revision||disposed)return;
  const selected=active.value&&`${active.value.shop_id}:${active.value.sku}`;
  Object.assign(state,{rows:data.rows||[],shops:data.shops||[],days:data.days||[],coverage:data.coverage||[],total:data.total||0,date:data.date||state.date,latest_available_date:data.latest_available_date||null,report_end_date:data.report_end_date||'',range_from:data.range_from||data.date,selected_count:Number(data.selected_count||0)});
  active.value=state.rows.find(row=>`${row.shop_id}:${row.sku}`===selected)||state.rows[0]||null;
  void loadTrend(active.value);
 }catch(e){if(ticket===revision&&!disposed){error.value=e.message||'日数据读取失败';state.rows=[];active.value=null;}}
 finally{if(ticket===revision&&!disposed)loading.value=false;}
}
function search(){
 if(rules.value.some(rule=>rule.value===null||rule.value===undefined)){ElMessage.warning('请填写每个指标条件的数值');return;}
 applied.value={...form,exact:form.exact?1:0,filters:JSON.stringify(rules.value)};return load(true);
}
function potential(){rules.value=[{metric:'conv_views_to_order',op:'gt',value:8},{metric:'total_views',op:'lt',value:20}];search();}
function clear(){rules.value=[];form.query='';search();}
function addRule(){if(rules.value.length<8)rules.value.push({metric:'total_views',op:'gte',value:null});}
function showLatest(){datePinned.value=false;return load(true);}
async function collect(selectedDate=false){
 queuing.value=true;
 try{const response=await collectSkuTrafficDaily({shop_id:state.shop_id,...(selectedDate?{date:state.date}:{})});const data=response.data||response;ElMessage.success(`已排队 ${data.queued?.length||0} 个店铺日，另有 ${data.waiting?.length||0} 个等待插件；排队不代表已完成`);wakeCollector();await load();}
 catch(e){ElMessage.error(e.message||'采集排队失败');}finally{queuing.value=false;}
}
function wakeCollector(){const shop=state.shops.find(s=>String(s.id)===String(state.shop_id));window.postMessage({type:'BAODAN_ANALYTICS_PLUGIN_WAKE',expectedStoreId:shop?.store_id||''},window.location.origin);}
const monitor=createDailyTrafficMonitor({refresh:()=>load(),busy:()=>loading.value||queuing.value,wake:()=>{if(!error.value&&state.coverage.some(day=>day.status==='pending'))wakeCollector();}});
onMounted(()=>monitor.start());onBeforeUnmount(()=>{disposed=true;revision++;detailRevision++;monitor.stop();});
</script>
<template>
 <div class="sku-traffic-monitor">
  <ErpPageHeader compact title="SKU 流量监控" description="筛选有潜力的商品，观察每天的流量与转化">
   <template #actions><el-popover trigger="click" width="360"><template #reference><el-button>采集状态</el-button></template><div v-for="shop in coverage" :key="shop.id" class="coverage-item"><span>{{shop.name}}</span><el-tag :type="shop.status==='complete'?'success':'info'">{{statusLabel[shop.status]||'未采集'}}</el-tag></div><p class="muted">{{state.date}} 的采集状态。插件及对应店铺登录页在线后执行。</p></el-popover><el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button><el-button :loading="queuing" @click="collect(true)">补采选定日</el-button><el-button type="primary" :loading="queuing" @click="collect(false)">同步日数据</el-button></template>
  </ErpPageHeader>
  <section class="filters">
   <div class="filter-row">
    <el-select v-model="state.shop_id" aria-label="店铺" class="shop-select" @change="load(true)"><el-option label="全部店铺" value="all"/><el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)"/></el-select>
    <el-select v-model="form.range_days" aria-label="统计范围" class="range-select" @change="search"><el-option label="单日" :value="1"/><el-option label="近7天" :value="7"/><el-option label="近15天" :value="15"/></el-select>
    <el-select v-model="state.date" aria-label="统计截至日期" class="date-select" @change="datePinned=true;load(true)"><el-option v-for="day in [...state.days].reverse()" :key="day" :label="`截至 ${day}`" :value="day"/></el-select>
    <el-select v-model="form.search_by" aria-label="搜索字段" class="field-select"><el-option label="全部字段" value="all"/><el-option label="SKU" value="sku"/><el-option label="货号" value="offer_id"/><el-option label="库存编号 / ID" value="inventory"/><el-option label="库存名称" value="inventory_name"/><el-option label="商品名称" value="product_name"/></el-select>
    <el-input v-model="form.query" class="keyword-input" placeholder="输入SKU、货号、库存编号或名称" clearable @keyup.enter="search"/>
    <el-checkbox v-model="form.exact">精确匹配</el-checkbox>
    <el-button type="primary" :icon="Search" @click="search">筛选</el-button>
   </div>
   <div class="filter-row metric-rules">
    <div v-for="(rule,index) in rules" :key="index" class="metric-rule"><el-select v-model="rule.metric" aria-label="筛选指标"><el-option v-for="[key,label] in metricOptions" :key="key" :label="label" :value="key"/></el-select><el-select v-model="rule.op" class="operator" aria-label="比较条件"><el-option v-for="[key,label] in comparisons" :key="key" :label="label" :value="key"/></el-select><el-input-number v-model="rule.value" :min="0" :controls="false" placeholder="数值" aria-label="指标阈值" @keyup.enter="search"/><el-button :icon="Delete" text aria-label="删除条件" @click="rules.splice(index,1)"/></div>
    <el-button :icon="Plus" :disabled="rules.length>=8" @click="addRule">指标条件</el-button><el-button @click="potential">高转化 · 低曝光</el-button><el-button text @click="clear">清空条件</el-button>
    <div class="sort-controls"><span class="muted">排序</span><el-select v-model="form.sort_key" aria-label="排序指标" @change="search"><el-option v-for="[key,label] in metricOptions" :key="key" :label="label" :value="key"/></el-select><el-select v-model="form.sort_order" class="direction" aria-label="排序方向" @change="search"><el-option label="从高到低" value="desc"/><el-option label="从低到高" value="asc"/></el-select></div>
   </div>
   <div class="report-context"><span>{{state.range_from}} 至 {{state.date}} · {{state.total.toLocaleString()}} 个商品符合条件</span><span>多项条件同时满足；指标按已采到的日期汇总，缺失不计0</span><el-button v-if="datePinned" link @click="showLatest">回到最近有数据日期</el-button></div>
  </section>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <el-alert v-else-if="state.latest_available_date&&state.date>state.latest_available_date" type="warning" :closable="false" :title="`${state.date} 尚无日指标；当前统计区间只汇总已有记录，右侧曲线保留缺失日。`"><el-button link type="primary" @click="showLatest">查看最近有数据的 {{state.latest_available_date}}</el-button></el-alert>
  <el-alert v-else-if="!datePinned&&state.latest_available_date&&state.date!==state.report_end_date" type="info" :closable="false" :title="`${state.report_end_date} 尚无日指标，当前自动显示最近有数据的 ${state.date}。`"/>
  <div class="workspace">
   <section class="product-list">
    <el-table v-loading="loading" :data="state.rows" :row-key="row=>`${row.shop_id}:${row.sku}`" :current-row-key="active?`${active.shop_id}:${active.sku}`:undefined" highlight-current-row height="620" @row-click="selectProduct">
     <el-table-column label="店铺" prop="shop_name" width="130" show-overflow-tooltip/>
     <el-table-column label="商品 / SKU / 货号" min-width="230"><template #default="{row}"><div class="product-brief" :title="row.product_name"><strong>{{shortName(row.product_name)}}</strong><span>SKU {{row.sku}}</span><span :title="row.offer_id">货号 {{row.offer_id||'—'}}</span></div></template></el-table-column>
     <el-table-column label="关联库存" min-width="170"><template #default="{row}"><div class="inventory-brief" :title="inventoryLabel(row)"><template v-if="row.inventory?.length"><strong>{{row.inventory.map(p=>p.inventory_number||p.code||'#'+p.id).join(' / ')}}</strong><span>{{row.inventory.map(p=>p.name).join(' / ')}}</span></template><span v-else class="muted">未关联库存</span></div></template></el-table-column>
     <el-table-column v-for="[key,label] in metrics" :key="key" :label="label" min-width="94" align="right"><template #default="{row}">{{number(row.summary?.[key])}}</template></el-table-column>
     <el-table-column label="曝光至下单率" min-width="110" align="right"><template #default="{row}">{{percent(row.summary?.conv_views_to_order)}}</template></el-table-column>
     <el-table-column label="记录天数" width="90" align="right"><template #default="{row}">{{row.summary?.available_days||0}} / {{applied.range_days}}</template></el-table-column>
     <template #empty><el-empty :description="error?'读取失败，请刷新重试':'暂无符合条件的日指标，可调整条件或补采日期。'"/></template>
    </el-table>
    <PageFooterPagination v-if="!error" :page="state.page" :page-size="state.pageSize" :total="state.total" @update:page="state.page=$event;load()" @update:page-size="state.pageSize=$event;load(true)"/>
   </section>
   <aside class="trend-panel">
    <template v-if="active"><div class="trend-heading"><span class="muted">{{active.shop_name}}</span><h3 :title="active.product_name">{{shortName(active.product_name)}}</h3><p>SKU {{active.sku}} · 货号 {{active.offer_id||'—'}}</p><p :title="inventoryLabel(active)">{{inventoryLabel(active)}}</p></div><el-radio-group v-model="chartGroup" size="small"><el-radio-button value="traffic">曝光 · 浏览 · 加购 · 下单</el-radio-button><el-radio-button value="rates">转化率</el-radio-button></el-radio-group><el-alert v-if="detailError" :title="detailError" type="error" :closable="false"/><div v-loading="detailLoading"><SkuTrafficTrendChart :series="chartSeries" :metrics="chartGroup==='traffic'?metrics:rates" :unit="chartGroup==='rates'?'%':''"/></div><p class="muted explanation">详情浏览不是广告点击；详情浏览率 = 详情浏览 ÷ 曝光。区间转化率按已采到的下单、加购和曝光量计算，单日沿用官方报表值。</p></template>
    <el-empty v-else description="选择左侧商品查看每日趋势"/>
   </aside>
  </div>
 </div>
</template>
<style scoped>
.sku-traffic-monitor{display:flex;flex-direction:column;gap:12px;padding:14px;color:var(--erp-text)}.filters,.trend-panel{background:var(--erp-surface);border:1px solid var(--erp-border);border-radius:10px;padding:12px}.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.filter-row+.filter-row{margin-top:10px}.shop-select{width:170px}.range-select{width:110px}.date-select{width:176px}.field-select{width:140px}.keyword-input{width:270px}.metric-rule,.sort-controls{display:flex;align-items:center;gap:5px}.metric-rule{padding:4px;background:var(--erp-surface-alt);border-radius:6px}.metric-rule>.el-select{width:190px}.metric-rule>.operator{width:64px}.metric-rule .el-input-number{width:100px}.sort-controls{margin-left:auto}.sort-controls>.el-select{width:170px}.sort-controls>.direction{width:118px}.report-context{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:10px;color:var(--erp-text-secondary);font-size:12px}.workspace{display:grid;grid-template-columns:minmax(650px,1.35fr) minmax(450px,1fr);gap:12px;align-items:start}.product-list{min-width:0}.product-brief,.inventory-brief{display:flex;flex-direction:column;gap:3px;min-width:0;line-height:1.5}.product-brief strong,.inventory-brief strong{font-size:12px;font-weight:500}.product-brief span,.inventory-brief span{font-size:11px;color:var(--erp-text-secondary)}.product-brief>* ,.inventory-brief>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.trend-panel{position:sticky;top:12px;min-width:0}.trend-heading{margin-bottom:14px}.trend-heading h3{font-size:14px;line-height:1.6;margin:4px 0}.trend-heading p{font-size:12px;color:var(--erp-text-secondary);margin:4px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.muted{font-size:12px;color:var(--erp-text-secondary)}.explanation{line-height:1.8;margin:10px 0 0}.coverage-item{display:flex;justify-content:space-between;gap:10px;margin:8px 0}.trend-panel :deep(.el-radio-group){margin-bottom:16px}@media(max-width:1400px){.workspace{grid-template-columns:minmax(0,1fr)}.trend-panel{position:static}.sort-controls{margin-left:0}}
</style>

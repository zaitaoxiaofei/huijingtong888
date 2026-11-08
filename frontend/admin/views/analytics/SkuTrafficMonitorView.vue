<script setup>
import {useRouter} from 'vue-router';
import {computed,onMounted,onBeforeUnmount,reactive,ref} from 'vue';
import {ElMessage} from 'element-plus';
import {Refresh,Search,Plus,Delete} from '@element-plus/icons-vue';
import ErpPageHeader from '../../components/ErpPageHeader.vue';
import PageFooterPagination from '../../components/PageFooterPagination.vue';
import SkuTrafficProductImage from '../../components/SkuTrafficProductImage.vue';
import SkuTrafficTrendChart from '../../components/SkuTrafficTrendChart.vue';
import {getSkuTrafficDaily,collectSkuTrafficDaily} from '../../api/sellerAnalytics';
import {createDailyTrafficMonitor} from '../../utils/sku-traffic-monitor-pump';
import {trafficRowSeries} from '../../utils/sku-traffic-row-series';
import {SKU_TRAFFIC_OPERATION_METRICS,SKU_TRAFFIC_PRIMARY_RATE_KEYS} from '../../../../src/shared/sku-traffic-monitor-query';
const router=useRouter();
function openDetail(row){router.push({name:'sku-traffic-detail',query:{shop_id:String(row.shop_id),sku:row.sku,date:state.date,range_days:String(applied.value.range_days)}});}
const state=reactive({rows:[],shops:[],days:[],coverage:[],total:0,date:'',latest_available_date:null,report_end_date:'',selected_count:0,range_from:'',shop_id:'all',page:1,pageSize:30});
const form=reactive({query:'',search_by:'all',exact:true,range_days:7,sort_key:'total_views',sort_order:'desc'});
const rules=ref([]),applied=ref({...form,filters:'[]'}),datePinned=ref(false);
const advanced=ref(false),backfill=ref(null);
const loading=ref(false),queuing=ref(false),error=ref(''),chartGroup=ref('rates');
let revision=0,disposed=false;
const metricOptions=SKU_TRAFFIC_OPERATION_METRICS;
const metrics=metricOptions.slice(0,5),rates=SKU_TRAFFIC_PRIMARY_RATE_KEYS.map(key=>metricOptions.find(([k])=>k===key));
const hoverMetrics=[...metrics.map(([key,label])=>({key,label,unit:''})),...rates.map(([key,label])=>({key,label:label.replace(/ ?%$/,''),unit:'%'}))];
const comparisons=[['gt','>'],['gte','≥'],['lt','<'],['lte','≤'],['eq','=']];
const number=value=>value===null||value===undefined?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:2});
const rateLabel=key=>({search_share:'搜索占比',detail_view_rate:'浏览率',pdp_order_rate:'浏览下单率'}[key]||key);
const percent=value=>value===null||value===undefined?'—':`${Number(value).toFixed(2)}%`;
const shortName=name=>String(name||'商品资料未同步').length>42?String(name).slice(0,42)+'…':name||'商品资料未同步';
const inventoryLabel=row=>row.inventory?.map(p=>`ID ${p.id} · ${p.inventory_number||p.code||''} ${p.name}`).join('；')||'未关联库存';
const statusLabel={complete:'完整',pending:'等待采集',partial:'未覆盖全店',failed:'采集失败',missing:'未采集'};
const coverage=computed(()=>state.shops.filter(shop=>state.shop_id==='all'||String(shop.id)===String(state.shop_id)).map(shop=>({...shop,...state.coverage.find(d=>d.shop_id===shop.id&&d.date_key===state.date)})));
const visibleKeys=ref([...metrics,...rates].map(([key])=>key));
const colors=['#4c9bff','#27c5a3','#f5b84c','#b28aff','#f47987'];
const chartOptions=computed(()=>(chartGroup.value==='traffic'?metrics:rates).map(([key,label],index)=>[key,label.replace(/ ?%$/,''),colors[index%colors.length]]));
const lineMetrics=computed(()=>chartOptions.value.filter(([key])=>visibleKeys.value.includes(key)));
function toggleLine(key){visibleKeys.value=visibleKeys.value.includes(key)?visibleKeys.value.filter(k=>k!==key):[...visibleKeys.value,key];}
async function load(reset=false){
 if(reset)state.page=1;
 const ticket=++revision;loading.value=true;error.value='';
 try{
  const data=await getSkuTrafficDaily({...applied.value,date:datePinned.value?state.date:undefined,date_mode:'latest_report_day',shop_id:state.shop_id,include_series:1,series_format:'matrix',page:state.page,pageSize:state.pageSize});
  if(ticket!==revision||disposed)return;
  Object.assign(state,{rows:(data.rows||[]).map(row=>({...row,series:trafficRowSeries(row,data)})),shops:state.shop_id==='all'||!state.shops.length?data.shops||[]:state.shops,days:data.days||[],coverage:data.coverage||[],total:data.total||0,date:data.date||state.date,latest_available_date:data.latest_available_date||null,report_end_date:data.report_end_date||'',range_from:data.range_from||data.date,selected_count:Number(data.selected_count||0)});
 }catch(e){if(ticket===revision&&!disposed){error.value=e.message||'日数据读取失败';state.rows=[];}}
 finally{if(ticket===revision&&!disposed)loading.value=false;}
}
function search(){
 if(rules.value.some(rule=>rule.value===null||rule.value===undefined)){ElMessage.warning('请填写每个指标条件的数值');return;}
 applied.value={...form,exact:form.exact?1:0,filters:JSON.stringify(rules.value)};return load(true);
}
function potential(){rules.value=[{metric:'pdp_order_rate',op:'gt',value:8},{metric:'total_views',op:'lt',value:20}];search();}
function clear(){rules.value=[];form.query='';datePinned.value=false;search();}
function addRule(){if(rules.value.length<8)rules.value.push({metric:'total_views',op:'gte',value:null});}
function showLatest(){datePinned.value=false;return load(true);}
async function collect(mode='latest',quiet=false){
 queuing.value=true;
 const scope=mode==='missing'?{range_days:form.range_days,missing_only:true}:mode==='day'?{date:state.date}:{range_days:1};
 if(mode==='missing')backfill.value={shop_id:state.shop_id,range_days:form.range_days};
 const shopId=mode==='missing'?backfill.value.shop_id:state.shop_id;
 try{const response=await collectSkuTrafficDaily({shop_id:shopId,...scope});const data=response.data||response;if(!quiet)ElMessage.success(`已排队 ${data.queued?.length||0} 个店铺日，${data.waiting?.length||0} 个任务进行中；插件在线后分日采集，未完成的日期继续排队`);wakeCollector();await load();}
 catch(e){backfill.value=null;ElMessage.error(e.message||'采集排队失败');}finally{queuing.value=false;}
}
async function continueBackfill(){
 const job=backfill.value;if(disposed||!job||queuing.value||error.value)return;
 if(job.shop_id!==state.shop_id){backfill.value=null;return;}
 const days=state.days.slice(-job.range_days),shops=state.shops.filter(shop=>job.shop_id==='all'||String(shop.id)===String(job.shop_id));
 const incomplete=shops.filter(shop=>days.some(day=>!state.coverage.some(c=>c.shop_id===shop.id&&c.date_key===day&&c.status==='complete')));
 if(!incomplete.length){backfill.value=null;return;}
 if(incomplete.some(shop=>!state.coverage.some(c=>c.shop_id===shop.id&&days.includes(c.date_key)&&c.status==='pending')))await collect('missing',true);
}
function wakeCollector(){const shop=state.shops.find(s=>String(s.id)===String(state.shop_id));window.postMessage({type:'BAODAN_ANALYTICS_PLUGIN_WAKE',expectedStoreId:shop?.store_id||''},window.location.origin);}
const monitor=createDailyTrafficMonitor({refresh:async()=>{await load();await continueBackfill();},busy:()=>loading.value||queuing.value,wake:()=>{if(!error.value&&state.coverage.some(day=>day.status==='pending'))wakeCollector();}});
onMounted(()=>monitor.start());onBeforeUnmount(()=>{disposed=true;revision++;monitor.stop();});
</script>
<template>
 <div class="sku-traffic-monitor">
  <ErpPageHeader compact title="SKU 流量监控" description="按库存关联对比多店铺SKU，观察每日流量和转化"/>
  <section class="filters">
   <div class="main-toolbar">
    <el-select v-model="state.shop_id" aria-label="店铺" class="shop-select" @change="backfill=null;load(true)"><el-option label="全部店铺" value="all"/><el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)"/></el-select>
    <el-select v-model="form.range_days" aria-label="统计范围" class="range-select" @change="backfill=null;search()"><el-option label="单日" :value="1"/><el-option label="近7天" :value="7"/><el-option label="近15天" :value="15"/></el-select>
    <el-select v-model="form.search_by" aria-label="搜索字段" class="field-select"><el-option label="全部字段" value="all"/><el-option label="库存ID" value="inventory_id"/><el-option label="库存编号" value="inventory"/><el-option label="库存名称" value="inventory_name"/><el-option label="SKU" value="sku"/><el-option label="货号" value="offer_id"/><el-option label="商品名称" value="product_name"/></el-select>
    <el-input v-model="form.query" class="keyword-input" :placeholder="form.search_by==='inventory_id'?'输入库存ID，跨店铺查看绑定SKU':'搜索库存、SKU、货号或名称'" clearable @keyup.enter="search"/>
    <el-button type="primary" :icon="Search" @click="search">搜索</el-button>
    <el-button :type="advanced||rules.length?'primary':'default'" plain @click="advanced=!advanced">更多筛选{{rules.length?' · '+rules.length:''}}</el-button>
    <el-select v-model="form.sort_key" class="sort-select" aria-label="排序指标" @change="search"><el-option v-for="[key,label] in metricOptions" :key="key" :label="label" :value="key"/></el-select>
    <el-button class="direction-button" @click="form.sort_order=form.sort_order==='desc'?'asc':'desc';search()">{{form.sort_order==='desc'?'↓ 降序':'↑ 升序'}}</el-button>
    <el-dropdown trigger="click" @command="mode=>collect(mode)"><el-button :loading="queuing">同步数据 ▾</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="missing">补齐{{state.shop_id==='all'?'各店铺':'该店铺'}}近{{form.range_days}}天缺失数据</el-dropdown-item><el-dropdown-item command="latest">同步最近日数据</el-dropdown-item><el-dropdown-item command="day">重新采集 {{state.date}}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
    <el-popover trigger="click" width="360"><template #reference><el-button>采集状态</el-button></template><div v-for="shop in coverage" :key="shop.id" class="coverage-item"><span>{{shop.name}}</span><el-tag :type="shop.status==='complete'?'success':'info'">{{statusLabel[shop.status]||'未采集'}}</el-tag></div><p class="muted">按Ozon报表日采集。插件及店铺登录页在线后执行。</p></el-popover>
    <el-button :icon="Refresh" :loading="loading" aria-label="刷新日数据" @click="load()"/>
   </div>
   <div v-if="advanced" class="advanced-search">
    <div class="advanced-heading"><strong>组合筛选</strong><span>同时满足以下条件</span><el-button link @click="clear">重置筛选</el-button></div>
    <div class="quick-filters"><span>常用</span><el-button size="small" @click="potential">高浏览下单率 · 低曝光</el-button><small>浏览下单率 &gt; 8%，总曝光 &lt; 20；阈值可编辑</small></div>
    <div class="filter-row metric-rules"><div v-for="(rule,index) in rules" :key="index" class="metric-rule"><el-select v-model="rule.metric" aria-label="筛选指标"><el-option v-for="[key,label] in metricOptions" :key="key" :label="label" :value="key"/></el-select><el-select v-model="rule.op" class="operator" aria-label="比较条件"><el-option v-for="[key,label] in comparisons" :key="key" :label="label" :value="key"/></el-select><el-input-number v-model="rule.value" :min="0" :controls="false" placeholder="数值" aria-label="指标阈值"/><el-button :icon="Delete" text aria-label="删除条件" @click="rules.splice(index,1)"/></div><el-button :icon="Plus" :disabled="rules.length>=8" @click="addRule">添加条件</el-button></div>
    <div class="advanced-footer"><el-checkbox v-model="form.exact">精确匹配</el-checkbox><span>历史回看</span><el-select v-model="state.date" aria-label="历史截至日期" class="date-select" @change="datePinned=true;load(true)"><el-option v-for="day in [...state.days].reverse()" :key="day" :label="day" :value="day"/></el-select><el-button v-if="datePinned" link @click="showLatest">回到最新数据</el-button><el-button type="primary" size="small" @click="search">应用筛选</el-button></div>
   </div>
  </section>
  <div class="report-context"><span>来源：Ozon插件采集 · {{state.range_from}} — {{state.date}} · {{state.total.toLocaleString()}} 个SKU</span><span v-if="applied.search_by==='inventory_id'&&applied.query">库存ID {{applied.query}} · 仅显示已绑定SKU</span><span v-if="backfill" class="backfill-status">正在补齐近{{backfill.range_days}}天；每店分批排队，请保持插件在线</span></div>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <el-alert v-else-if="state.latest_available_date&&state.date>state.latest_available_date" type="warning" :closable="false" :title="`${state.date} 尚无日指标；当前统计区间只汇总已有记录，右侧曲线保留缺失日。`"><el-button link type="primary" @click="showLatest">查看最近有数据的 {{state.latest_available_date}}</el-button></el-alert>
  <el-alert v-else-if="!datePinned&&state.latest_available_date&&state.date!==state.report_end_date" type="info" :closable="false" :title="`${state.report_end_date} 尚无日指标，当前自动显示最近有数据的 ${state.date}。`"/>
  <div class="row-chart-controls">
   <el-radio-group v-model="chartGroup" size="small"><el-radio-button value="rates">经营比率 %</el-radio-button><el-radio-button value="traffic">流量与下单</el-radio-button></el-radio-group>
   <div class="row-legend"><button v-for="[key,label,color] in chartOptions" :key="key" type="button" :class="{inactive:!visibleKeys.includes(key)}" :aria-pressed="visibleKeys.includes(key)" @click="toggleLine(key)"><i :style="{background:color}"/>{{label}}</button></div>
   <span class="muted">每个SKU一行，悬浮该行曲线查看当天数据</span>
  </div>
  <div v-loading="loading" class="records-scroll">
   <div class="sku-records" role="table" aria-label="SKU逐行流量趋势">
    <div class="sku-record row-head" role="row"><span role="columnheader">店铺</span><span role="columnheader">商品 / SKU / 货号</span><span role="columnheader">关联库存</span><span role="columnheader">区间合计 · 不随悬浮改变</span><span role="columnheader">每日趋势 · 纵轴{{chartGroup==='rates'?'比例 %':'次数 / 件数'}}</span></div>
    <article v-for="row in state.rows" :key="`${row.shop_id}:${row.sku}`" class="sku-record" role="row" :aria-label="`SKU ${row.sku}`">
     <div role="cell" class="row-shop">{{row.shop_name}}</div>
     <div role="cell" class="product-cell"><SkuTrafficProductImage :src="row.image_url||''" :alt="row.product_name||'商品主图'"/><div class="product-brief" :title="row.product_name"><strong>{{shortName(row.product_name)}}</strong><span>SKU {{row.sku}}</span><span :title="row.offer_id">货号 {{row.offer_id||'—'}}</span><button type="button" class="detail-link" @click="openDetail(row)">查看明细</button></div></div>
     <div role="cell" class="inventory-brief" :title="inventoryLabel(row)"><template v-if="row.inventory?.length"><strong>{{row.inventory.map(p=>`ID ${p.id} · ${p.inventory_number||p.code||''}`).join(' / ')}}</strong><span>{{row.inventory.map(p=>p.name).join(' / ')}}</span></template><span v-else class="muted">未关联库存</span></div>
     <div role="cell"><div class="row-metrics"><span v-for="[key,label] in metrics" :key="key">{{label}}<b>{{number(row.summary?.[key])}}</b></span><span v-for="[key,label] in rates" :key="key">{{rateLabel(key)}}<b>{{percent(row.summary?.[key])}}</b></span></div><small class="muted">{{row.summary?.available_days||0}} / {{row.series.length}} 天有日记录</small></div>
     <div role="cell" class="row-trend"><SkuTrafficTrendChart compact :tooltip-metrics="hoverMetrics" :series="row.series" :metrics="lineMetrics" :unit="chartGroup==='rates'?'%':''"/></div>
    </article>
    <div v-if="!state.rows.length" class="record-empty"><el-empty :description="error?'读取失败，请刷新重试':'暂无符合条件的日指标，可调整条件或补采日期。'"/></div>
   </div>
  </div>
  <PageFooterPagination v-if="!error" :page="state.page" :page-size="state.pageSize" :total="state.total" @update:page="state.page=$event;load()" @update:page-size="state.pageSize=$event;load(true)"/>
  <p class="muted">搜索曝光占比 = 搜索曝光 ÷ 总曝光；详情浏览率 = 浏览 ÷ 总曝光；浏览→下单率 = 下单件数 ÷ 详情浏览次数。浏览并非独立访客或广告点击，以上不是广告CTR；分母为0或缺数据时不计算。</p>
 </div>
</template>
<style scoped>
.sku-traffic-monitor{display:flex;flex-direction:column;gap:12px;padding:14px;color:var(--erp-text)}.main-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px}.main-toolbar>*{flex-shrink:0}.sort-select{width:150px}.direction-button{padding:8px 10px}.advanced-search{border-top:1px solid var(--erp-border);margin-top:14px;padding-top:14px;display:flex;flex-direction:column;gap:12px}.advanced-heading,.quick-filters,.advanced-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px}.advanced-heading>span,.quick-filters>span,.quick-filters>small{color:var(--erp-text-secondary)}.advanced-heading>.el-button{margin-left:auto}.backfill-status{color:var(--el-color-primary)}.filters{background:var(--erp-surface);border:1px solid var(--erp-border);border-radius:10px;padding:12px}.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.filter-row+.filter-row{margin-top:10px}.shop-select{width:145px}.range-select{width:95px}.date-select{width:176px}.field-select{width:108px}.keyword-input{min-width:190px;max-width:300px;flex:1}.metric-rule,.sort-controls{display:flex;align-items:center;gap:5px}.metric-rule{padding:4px;background:var(--erp-surface-alt);border-radius:6px}.metric-rule>.el-select{width:190px}.metric-rule>.operator{width:64px}.metric-rule .el-input-number{width:100px}.sort-controls{margin-left:auto}.sort-controls>.el-select{width:170px}.sort-controls>.direction{width:118px}.report-context{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:10px;color:var(--erp-text-secondary);font-size:12px}.row-chart-controls{display:flex;align-items:center;flex-wrap:wrap;gap:14px}.row-legend{display:flex;flex-wrap:wrap;gap:12px}.row-legend button{display:flex;align-items:center;gap:5px;background:none;border:0;color:var(--erp-text);font-size:12px;cursor:pointer;padding:0}.row-legend i{height:8px;width:8px;border-radius:50%}.row-legend .inactive{opacity:.35}.records-scroll{overflow-x:auto;border:1px solid var(--erp-border);border-radius:8px;background:var(--erp-surface)}.sku-records{min-width:1240px}.sku-record{display:grid;grid-template-columns:110px minmax(280px,1fr) minmax(150px,.55fr) 220px minmax(420px,1.7fr);align-items:center;gap:14px;padding:8px 12px;min-height:128px;border-bottom:1px solid var(--erp-border)}.sku-record:last-child{border-bottom:0}.row-head{min-height:38px;background:var(--erp-surface-alt);font-size:12px;font-weight:600}.row-shop{font-size:12px;font-weight:600;line-height:1.5}.product-cell{display:flex;align-items:center;gap:12px;min-width:0}.product-brief{flex:1}.product-brief,.inventory-brief{display:flex;flex-direction:column;gap:5px;min-width:0;line-height:1.5}.product-brief strong,.inventory-brief strong{font-size:12px;font-weight:500}.product-brief span,.inventory-brief span{font-size:11px;color:var(--erp-text-secondary)}.product-brief>*,.inventory-brief>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-metrics{display:grid;grid-template-columns:1fr 1fr;gap:5px 10px;font-size:11px;margin-bottom:8px}.row-metrics span{display:flex;justify-content:space-between;gap:5px;color:var(--erp-text-secondary)}.row-metrics b{font-weight:500;color:var(--erp-text)}.detail-link{align-self:flex-start;padding:0;border:0;background:none;color:var(--el-color-primary);font-size:12px;cursor:pointer}.row-trend{min-width:0}.record-empty{padding:20px}.muted{font-size:12px;color:var(--erp-text-secondary)}.coverage-item{display:flex;justify-content:space-between;gap:10px;margin:8px 0}@media(max-width:1400px){.sort-controls{margin-left:0}}
</style>

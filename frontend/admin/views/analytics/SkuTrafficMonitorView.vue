<script setup>
import {useRouter} from 'vue-router';
import {computed,onMounted,onBeforeUnmount,reactive,ref} from 'vue';
import {ElMessage} from 'element-plus';
import {Refresh,Search,Plus,Delete} from '@element-plus/icons-vue';
import ErpPageHeader from '../../components/ErpPageHeader.vue';
import PageFooterPagination from '../../components/PageFooterPagination.vue';
import SkuTrafficProductImage from '../../components/SkuTrafficProductImage.vue';
import SkuTrafficTrendChart from '../../components/SkuTrafficTrendChart.vue';
import {getSkuTrafficDaily,collectSkuTrafficDaily,prepareSellerAnalyticsPlugin} from '../../api/sellerAnalytics';
import {createDailyTrafficMonitor} from '../../utils/sku-traffic-monitor-pump';
import {createTrafficBrowserBridge} from '../../utils/sku-traffic-browser-bridge';
import {collectionDayState,verifiedCollectionShop} from '../../utils/sku-traffic-collection-state';
import {trafficRowSeries} from '../../utils/sku-traffic-row-series';
import {SKU_TRAFFIC_OPERATION_METRICS,SKU_TRAFFIC_PRIMARY_RATE_KEYS} from '../../../../src/shared/sku-traffic-monitor-query';
const router=useRouter();
function openDetail(row){router.push({name:'sku-traffic-detail',query:{shop_id:String(row.shop_id),sku:row.sku,date:state.date,range_days:String(applied.value.range_days)}});}
const state=reactive({rows:[],shops:[],days:[],coverage:[],total:0,date:'',latest_available_date:null,report_end_date:'',selected_count:0,range_from:'',shop_id:'all',page:1,pageSize:30});
const form=reactive({query:'',search_by:'all',exact:true,range_days:7,sort_key:'total_views',sort_order:'desc'});
const rules=ref([]),applied=ref({...form,filters:'[]'}),datePinned=ref(false);
const advanced=ref(false),backfill=ref(null),syncDrawer=ref(false);
const localBrowser=reactive({ok:false,companyId:'',pluginInstanceId:'',version:'',checking:false,preparing:false,message:'正在连接本机插件'});
let identifyRevision=0,statusRevision=0,statusTimer=0,lastIdentityCheck=0;
const browserBridge=createTrafficBrowserBridge({onInstance:info=>{localBrowser.pluginInstanceId=info.instanceId;localBrowser.version=info.version;void identifyStore();}});
const detectedShop=computed(()=>state.shops.find(s=>String(s.store_id)===String(localBrowser.companyId)));
const collectionShop=computed(()=>state.shop_id==='all'?detectedShop.value:state.shops.find(s=>String(s.id)===String(state.shop_id)));
const syncDays=computed(()=>!collectionShop.value?[]:[...state.days].reverse().map(date_key=>{const day=state.coverage.find(c=>c.date_key===date_key&&c.shop_id===collectionShop.value?.id);return {date_key,...day,...collectionDayState(day,localBrowser.pluginInstanceId)};}));
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
const visibleKeys=ref([...metrics,...rates].map(([key])=>key));
const colors=['#4c9bff','#27c5a3','#f5b84c','#b28aff','#f47987'];
const chartOptions=computed(()=>(chartGroup.value==='traffic'?metrics:rates).map(([key,label],index)=>[key,label.replace(/ ?%$/,''),colors[index%colors.length]]));
const lineMetrics=computed(()=>chartOptions.value.filter(([key])=>visibleKeys.value.includes(key)));
function toggleLine(key){visibleKeys.value=visibleKeys.value.includes(key)?visibleKeys.value.filter(k=>k!==key):[...visibleKeys.value,key];}
async function load(reset=false){
 if(reset)state.page=1;
 const ticket=++revision;loading.value=true;error.value='';
 try{
  const data=await getSkuTrafficDaily({...applied.value,date:datePinned.value?state.date:undefined,date_mode:'latest_report_day',shop_id:state.shop_id,include_series:1,include_progress:1,series_format:'matrix',page:state.page,pageSize:state.pageSize});
  if(ticket!==revision||disposed)return;
  statusRevision++;Object.assign(state,{rows:(data.rows||[]).map(row=>({...row,series:trafficRowSeries(row,data)})),shops:state.shop_id==='all'||!state.shops.length?data.shops||[]:state.shops,days:data.days||[],coverage:data.coverage||[],total:data.total||0,date:data.date||state.date,latest_available_date:data.latest_available_date||null,report_end_date:data.report_end_date||'',range_from:data.range_from||data.date,selected_count:Number(data.selected_count||0)});
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
async function identifyStore(){
 const ticket=++identifyRevision,selection=state.shop_id;localBrowser.checking=true;localBrowser.ok=false;
 const selected=state.shops.find(shop=>String(shop.id)===String(selection));
 try{
  const result=await browserBridge.check(selected?.store_id||'');
  if(disposed||ticket!==identifyRevision||selection!==state.shop_id)return;
  if(!result)throw new Error('插件身份发生变化，请重新识别');
  localBrowser.companyId=String(result.companyId||result.pageCompanyId||result.observedCompanyId||'');
  localBrowser.ok=result.ok===true&&!!result.companyId;
  localBrowser.message=localBrowser.ok?'本机店铺身份已验证':result.code==='store_mismatch'?`请在Ozon后台切换到${selected?.name||'所选店铺'}，再点击重新识别`:'店铺尚未验证，请打开对应Ozon分析页后重新识别';
  if(localBrowser.ok)localBrowser.preparing=false;
 }catch(e){if(ticket===identifyRevision&&!disposed)localBrowser.message=e.message;}
 finally{if(ticket===identifyRevision&&!disposed){localBrowser.checking=false;lastIdentityCheck=Date.now();}}
}
async function openLocalAnalytics(){
 const target=collectionShop.value;if(!target){ElMessage.warning('请先选择一家已配置店铺，再打开本机Ozon分析页');return;}
 if(!localBrowser.pluginInstanceId){ElMessage.warning('本机插件未连接，请先启用插件');return;}
 try{await prepareSellerAnalyticsPlugin({plugin_instance_id:localBrowser.pluginInstanceId,store_id:target.store_id,company_id:target.store_id,shop_name:target.name});localBrowser.preparing=true;localBrowser.message='正在本机打开分析页并验证店铺；ERP切换不会代替Ozon后台切店';browserBridge.wake(target.store_id);}
 catch(e){ElMessage.error(e.message||'打开分析页失败');}
}
function changeShop(){backfill.value=null;identifyRevision++;localBrowser.ok=false;void load(true);void identifyStore();}
async function refreshStatus(){
 if(disposed)return;const selection=state.shop_id,ticket=++statusRevision;
 try{const data=await getSkuTrafficDaily({shop_id:selection,metadata_only:1,include_progress:1});if(disposed||ticket!==statusRevision||selection!==state.shop_id)return;state.coverage=data.coverage||[];if(!localBrowser.checking&&(localBrowser.preparing||Date.now()-lastIdentityCheck>=30000))await identifyStore();}
 catch{ /* Keep last observed status; never promote a failed status read to success. */ }
}
async function collect(mode='latest',quiet=false){
 if(queuing.value||disposed)return;queuing.value=true;if(!quiet)syncDrawer.value=true;
 try{
  if(!quiet)backfill.value=null;
  const range=mode==='missing'?(backfill.value?.range_days||form.range_days):1;
  const known=collectionShop.value,targetDays=mode==='day'?[state.date]:state.days.slice(-range);
  if(state.shop_id!=='all'&&mode!=='day'&&known&&targetDays.length&&targetDays.every(date=>state.coverage.some(d=>d.shop_id===known.id&&d.date_key===date&&d.status==='complete'))){backfill.value=null;if(!quiet)ElMessage.info('这些日期已入库，无需重复同步；可直接查看数据');return;}
  await identifyStore();if(disposed)return;if(!localBrowser.ok)throw new Error(localBrowser.message);
  const shop=verifiedCollectionShop(state.shops,state.shop_id,localBrowser);
  if(quiet&&backfill.value&&backfill.value.shop_id!==String(shop.id))throw new Error('本机Ozon店铺已切换，已暂停原店铺补采；请确认店铺后重新启动');
  if(mode!=='day'&&targetDays.length&&targetDays.every(date=>state.coverage.some(d=>d.shop_id===shop.id&&d.date_key===date&&d.status==='complete'))){backfill.value=null;if(!quiet)ElMessage.info('这些日期已入库，无需重复同步；可直接查看数据');return;}
  if(mode==='missing')backfill.value={shop_id:String(shop.id),range_days:range};
  const scope=mode==='day'?{date:state.date}:{range_days:range,missing_only:true};
  const response=await collectSkuTrafficDaily({shop_id:String(shop.id),browser_instance_id:localBrowser.pluginInstanceId,...scope});if(disposed)return;
  const data=response.data||response;
  if(!quiet){if(data.queued?.length)ElMessage.info(`已为${shop.name}排队${data.queued.length}个报表日，等待本机插件领取`);else if(data.waiting?.length)ElMessage.info('已有任务等待或正在采集，请查看日期状态');else ElMessage.info('日期已同步或由其他浏览器完成，无需重复采集');}
  browserBridge.wake(shop.store_id);await load();await refreshStatus();
 }catch(e){backfill.value=null;localBrowser.ok=false;localBrowser.message=e.message;ElMessage.warning(e.message||'尚未满足本机店铺采集条件');}
 finally{queuing.value=false;}
}
async function continueBackfill(){
 const job=backfill.value;if(disposed||!job||queuing.value||error.value)return;
 if(state.shop_id!=='all'&&job.shop_id!==String(state.shop_id)){backfill.value=null;return;}
 const days=state.days.slice(-job.range_days),shop=state.shops.find(s=>String(s.id)===job.shop_id);if(!shop)return;
 if(days.every(date=>state.coverage.some(c=>c.shop_id===shop.id&&c.date_key===date&&c.status==='complete'))){backfill.value=null;return;}
 if(!state.coverage.some(c=>c.shop_id===shop.id&&days.includes(c.date_key)&&c.status==='pending'))await collect('missing',true);
}
function wakeCollector(){if(localBrowser.ok&&detectedShop.value)browserBridge.wake(detectedShop.value.store_id);}
const monitor=createDailyTrafficMonitor({refresh:async()=>{await load();await continueBackfill();},busy:()=>loading.value||queuing.value,wake:()=>{if(!error.value)wakeCollector();}});
onMounted(()=>{browserBridge.start();monitor.start();statusTimer=window.setInterval(()=>{void refreshStatus();},10000);});
onBeforeUnmount(()=>{disposed=true;revision++;identifyRevision++;statusRevision++;monitor.stop();browserBridge.stop();window.clearInterval(statusTimer);});
</script>
<template>
 <div class="sku-traffic-monitor">
  <ErpPageHeader compact title="SKU 流量监控" description="按库存关联对比多店铺SKU，观察每日流量和转化"/>
  <section class="filters">
   <div class="main-toolbar">
    <el-select v-model="state.shop_id" aria-label="店铺" class="shop-select" @change="changeShop"><el-option label="全部店铺" value="all"/><el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)"/></el-select>
    <el-select v-model="form.range_days" aria-label="统计范围" class="range-select" @change="backfill=null;search()"><el-option label="单日" :value="1"/><el-option label="近7天" :value="7"/><el-option label="近15天" :value="15"/><el-option label="近30天" :value="30"/></el-select>
    <el-select v-model="form.search_by" aria-label="搜索字段" class="field-select"><el-option label="全部字段" value="all"/><el-option label="库存ID" value="inventory_id"/><el-option label="库存编号" value="inventory"/><el-option label="库存名称" value="inventory_name"/><el-option label="SKU" value="sku"/><el-option label="货号" value="offer_id"/><el-option label="商品名称" value="product_name"/></el-select>
    <el-input v-model="form.query" class="keyword-input" :placeholder="form.search_by==='inventory_id'?'输入库存ID，跨店铺查看绑定SKU':'搜索库存、SKU、货号或名称'" clearable @keyup.enter="search"/>
    <el-button type="primary" :icon="Search" @click="search">搜索</el-button>
    <el-button :type="advanced||rules.length?'primary':'default'" plain @click="advanced=!advanced">更多筛选{{rules.length?' · '+rules.length:''}}</el-button>
    <el-select v-model="form.sort_key" class="sort-select" aria-label="排序指标" @change="search"><el-option v-for="[key,label] in metricOptions" :key="key" :label="label" :value="key"/></el-select>
    <el-button class="direction-button" @click="form.sort_order=form.sort_order==='desc'?'asc':'desc';search()">{{form.sort_order==='desc'?'↓ 降序':'↑ 升序'}}</el-button>
    <el-dropdown trigger="click" @command="mode=>collect(mode)"><el-button :loading="queuing">同步当前店铺 ▾</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="missing">补齐本机当前店铺近{{form.range_days}}天缺失数据</el-dropdown-item><el-dropdown-item command="latest">同步最近日数据</el-dropdown-item><el-dropdown-item command="day">重新采集 {{state.date}}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
    <el-button @click="syncDrawer=true">同步状态</el-button>
    <el-button :icon="Refresh" :loading="loading" aria-label="刷新日数据" @click="load()"/>
   </div>

  </section>
   <el-dialog v-model="advanced" title="组合筛选" width="min(660px, 94vw)" top="8vh" append-to-body><div class="advanced-search">
    <div class="advanced-heading"><span>同时满足以下条件（AND）</span><el-button link @click="clear">重置筛选</el-button></div>
    <div class="quick-filters"><span>常用</span><el-button size="small" @click="potential">高浏览下单率 · 低曝光</el-button><small>浏览下单率 &gt; 8%，总曝光 &lt; 20；阈值可编辑</small></div>
    <div class="filter-row metric-rules"><div v-for="(rule,index) in rules" :key="index" class="metric-rule"><el-select v-model="rule.metric" aria-label="筛选指标"><el-option v-for="[key,label] in metricOptions" :key="key" :label="label" :value="key"/></el-select><el-select v-model="rule.op" class="operator" aria-label="比较条件"><el-option v-for="[key,label] in comparisons" :key="key" :label="label" :value="key"/></el-select><el-input-number v-model="rule.value" :min="0" :controls="false" placeholder="数值" aria-label="指标阈值"/><el-button :icon="Delete" text aria-label="删除条件" @click="rules.splice(index,1)"/></div><el-button :icon="Plus" :disabled="rules.length>=8" @click="addRule">添加条件</el-button></div>
    <div class="advanced-footer"><el-checkbox v-model="form.exact">精确匹配</el-checkbox><span>历史回看</span><el-select v-model="state.date" aria-label="历史截至日期" class="date-select" @change="datePinned=true;load(true)"><el-option v-for="day in [...state.days].reverse()" :key="day" :label="day" :value="day"/></el-select><el-button v-if="datePinned" link @click="showLatest">回到最新数据</el-button><el-button type="primary" size="small" @click="search">应用筛选</el-button></div>
   </div></el-dialog>
  <div class="report-context"><span>来源：Ozon插件采集 · {{state.range_from}} — {{state.date}} · {{state.total.toLocaleString()}} 个SKU</span><span v-if="applied.search_by==='inventory_id'&&applied.query">库存ID {{applied.query}} · 仅显示已绑定SKU</span></div>
  <div class="browser-connection"><span class="connection-dot" :class="{ready:localBrowser.ok}"/><strong>本机Ozon：{{detectedShop?.name||'尚未识别'}}</strong><span>{{localBrowser.message}}</span><el-button link type="primary" :loading="localBrowser.checking" @click="identifyStore">重新识别</el-button><el-button v-if="!localBrowser.ok" link type="primary" @click="openLocalAnalytics">打开分析页</el-button><span class="retention-note">日指标保留30天</span></div>
  <p v-if="error" class="inline-error">{{error}}</p><p v-else-if="state.latest_available_date&&state.date>state.latest_available_date" class="data-gap-note">{{state.date}} 尚未采集 · 最近有数据：{{state.latest_available_date}}</p>
  <div v-loading="loading" class="records-scroll">
   <div class="sku-records" role="table" aria-label="SKU逐行流量趋势">
    <div class="sku-record row-head" role="row"><span role="columnheader">店铺</span><span role="columnheader">商品 / SKU / 货号</span><span role="columnheader">关联库存</span><span role="columnheader">区间合计 · 不随悬浮改变</span><div role="columnheader" class="trend-heading"><div class="trend-heading-top"><span>每日趋势</span><span>纵轴：{{chartGroup==='rates'?'百分比 %':'次数 / 件数'}}</span></div>  <div class="row-chart-controls">
   <el-radio-group v-model="chartGroup" size="small"><el-radio-button value="rates">百分比趋势</el-radio-button><el-radio-button value="traffic">数量趋势</el-radio-button></el-radio-group>
   <div class="row-legend"><button v-for="[key,label,color] in chartOptions" :key="key" type="button" :class="{inactive:!visibleKeys.includes(key)}" :aria-pressed="visibleKeys.includes(key)" @click="toggleLine(key)"><i :style="{background:color}"/>{{label}}</button></div>

  </div>
</div></div>
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
  <el-drawer v-model="syncDrawer" title="店铺同步状态" size="min(540px, 95vw)" append-to-body><div class="sync-summary"><strong>{{collectionShop?.name||'请先识别或选择店铺'}}</strong><p>{{localBrowser.message}}</p><p>本机插件：{{localBrowser.version||'未连接'}}</p><p>排队不代表已采集；只有“已入库”才计为完整日记录。已完成日期会自动跳过。</p><el-button :loading="localBrowser.checking" @click="identifyStore">识别本机店铺</el-button><el-button @click="refreshStatus">刷新状态</el-button></div><el-empty v-if="!collectionShop" description="选择一家店铺或识别本机Ozon店铺后，显示该店逐日状态"/><div v-for="day in syncDays" :key="day.date_key" class="sync-day"><strong>{{day.date_key}}</strong><div><span :class="'sync-kind-'+day.kind">{{day.label}}</span><small>{{day.detail}}</small></div></div></el-drawer>
  <PageFooterPagination v-if="!error" :page="state.page" :page-size="state.pageSize" :total="state.total" @update:page="state.page=$event;load()" @update:page-size="state.pageSize=$event;load(true)"/>
  <p class="muted">搜索曝光占比 = 搜索曝光 ÷ 总曝光；详情浏览率 = 浏览 ÷ 总曝光；浏览→下单率 = 下单件数 ÷ 详情浏览次数。浏览并非独立访客或广告点击，以上不是广告CTR；分母为0或缺数据时不计算。</p>
 </div>
</template>
<style scoped>
.sku-traffic-monitor{display:flex;flex-direction:column;gap:12px;padding:14px;color:var(--erp-text)}.main-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px}.main-toolbar>*{flex-shrink:0}.sort-select{width:150px}.direction-button{padding:8px 10px}.advanced-search{max-height:65vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px}.advanced-heading,.quick-filters,.advanced-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px}.advanced-heading>span,.quick-filters>span,.quick-filters>small{color:var(--erp-text-secondary)}.advanced-heading>.el-button{margin-left:auto}.backfill-status{color:var(--el-color-primary)}.browser-connection{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--erp-text-secondary)}.browser-connection strong{font-size:12px;color:var(--erp-text)}.connection-dot{width:6px;height:6px;border-radius:50%;background:#d6a143}.connection-dot.ready{background:#27b99c}.retention-note{margin-left:auto}.data-gap-note{margin:0;color:var(--erp-text-secondary);font-size:11px}.inline-error{color:var(--el-color-danger);font-size:12px;margin:0}.sync-summary{font-size:12px;line-height:1.8;margin-bottom:18px}.sync-summary p{color:var(--erp-text-secondary)}.sync-day{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--erp-border);font-size:12px}.sync-day>div{display:flex;flex-direction:column;gap:5px;text-align:right}.sync-day small{color:var(--erp-text-secondary)}.sync-kind-complete{color:#27b99c}.sync-kind-running,.sync-kind-publishing{color:var(--el-color-primary)}.sync-kind-stale{color:var(--el-color-warning)}.sync-kind-failed{color:var(--el-color-danger)}.sync-kind-queued,.sync-kind-missing{color:var(--erp-text-secondary)}.filters{background:var(--erp-surface);border:1px solid var(--erp-border);border-radius:10px;padding:12px}.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.filter-row+.filter-row{margin-top:10px}.shop-select{width:145px}.range-select{width:95px}.date-select{width:176px}.field-select{width:108px}.keyword-input{min-width:190px;max-width:300px;flex:1}.metric-rule,.sort-controls{display:flex;align-items:center;gap:5px}.metric-rule{padding:4px;background:var(--erp-surface-alt);border-radius:6px}.metric-rule>.el-select{width:190px}.metric-rule>.operator{width:64px}.metric-rule .el-input-number{width:100px}.sort-controls{margin-left:auto}.sort-controls>.el-select{width:170px}.sort-controls>.direction{width:118px}.report-context{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:10px;color:var(--erp-text-secondary);font-size:12px}.row-chart-controls{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:8px}.row-chart-controls :deep(.el-radio-button__inner){font-size:11px;padding:5px 9px}.trend-heading{min-width:0}.trend-heading-top{display:flex;justify-content:space-between;gap:10px}.trend-heading-top>span+span{font-size:10px;font-weight:400;color:var(--erp-text-secondary)}.row-legend{display:flex;flex-wrap:wrap;gap:6px 10px;font-weight:400}.row-legend button{font-size:10px!important}.row-legend button{display:flex;align-items:center;gap:5px;background:none;border:0;color:var(--erp-text);font-size:12px;cursor:pointer;padding:0}.row-legend i{height:8px;width:8px;border-radius:50%}.row-legend .inactive{opacity:.35}.records-scroll{overflow-x:auto;border:1px solid var(--erp-border);border-radius:8px;background:var(--erp-surface)}.sku-records{min-width:1240px}.sku-record{display:grid;grid-template-columns:110px minmax(280px,1fr) minmax(150px,.55fr) 220px minmax(420px,1.7fr);align-items:center;gap:14px;padding:8px 12px;min-height:128px;border-bottom:1px solid var(--erp-border)}.sku-record:last-child{border-bottom:0}.row-head{min-height:72px;background:var(--erp-surface-alt);font-size:12px;font-weight:600}.row-shop{font-size:12px;font-weight:600;line-height:1.5}.product-cell{display:flex;align-items:center;gap:12px;min-width:0}.product-brief{flex:1}.product-brief,.inventory-brief{display:flex;flex-direction:column;gap:5px;min-width:0;line-height:1.5}.product-brief strong,.inventory-brief strong{font-size:12px;font-weight:500}.product-brief span,.inventory-brief span{font-size:11px;color:var(--erp-text-secondary)}.product-brief>*,.inventory-brief>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-metrics{display:grid;grid-template-columns:1fr 1fr;gap:5px 10px;font-size:11px;margin-bottom:8px}.row-metrics span{display:flex;justify-content:space-between;gap:5px;color:var(--erp-text-secondary)}.row-metrics b{font-weight:500;color:var(--erp-text)}.detail-link{align-self:flex-start;padding:0;border:0;background:none;color:var(--el-color-primary);font-size:12px;cursor:pointer}.row-trend{min-width:0}.record-empty{padding:20px}.muted{font-size:12px;color:var(--erp-text-secondary)}.coverage-item{display:flex;justify-content:space-between;gap:10px;margin:8px 0}@media(max-width:1400px){.sort-controls{margin-left:0}}
</style>

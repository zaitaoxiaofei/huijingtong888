<script setup>
import {useRouter,useRoute,onBeforeRouteLeave} from 'vue-router';
import {computed,nextTick,onActivated,onDeactivated,onMounted,onBeforeUnmount,reactive,ref,watch} from 'vue';
import {ElMessage} from 'element-plus';
import {Refresh,Search,Plus,Delete} from '@element-plus/icons-vue';
import ErpPageHeader from '../../components/ErpPageHeader.vue';
import PageFooterPagination from '../../components/PageFooterPagination.vue';
import SkuTrafficProductImage from '../../components/SkuTrafficProductImage.vue';
import SkuTrafficTrendChart from '../../components/SkuTrafficTrendChart.vue';
import {getSkuTrafficDaily,saveSkuTrafficWatch} from '../../api/sellerAnalytics';
import {trafficRowSeries} from '../../utils/sku-traffic-row-series';
import {SKU_TRAFFIC_OPERATION_METRICS,SKU_TRAFFIC_PRIMARY_RATE_KEYS} from '../../../../src/shared/sku-traffic-monitor-query';
import {DEFAULT_TRAFFIC_TAGS,FOCUSED_TRAFFIC_TAG,trafficRowTags} from '../../../../src/shared/sku-traffic-tags';
import {useAuthStore} from '../../stores/auth';
import {apiClient} from '../../utils/api';
import {dailyCollectionRoute,intervalCollectionRoute,monitorContextQuery,preferredMonitorShops,monitorPreferenceKey} from '../../utils/sku-traffic-navigation';
const router=useRouter(),route=useRoute(),auth=useAuthStore();
const preferenceKey=computed(()=>monitorPreferenceKey(auth.user?.tenant?.id));
const sessionKey=computed(()=>`${preferenceKey.value}:${auth.user?.personId||auth.user?.person_id||auth.user?.id||'anonymous'}`);
const monitorRoot=ref(null);
function savedMonitor(){try{return JSON.parse(sessionStorage.getItem(sessionKey.value)||'{}');}catch{return {};}}
function scrollContainer(){return monitorRoot.value?.closest('.erp-workspace-panel')||document.scrollingElement;}
function saveMonitor(){const query=monitorQuery();query.scroll_top=scrollContainer()?.scrollTop||0;try{sessionStorage.setItem(sessionKey.value,JSON.stringify(query));}catch{}return query;}
async function restoreScroll(){await nextTick();const top=Number(savedMonitor().scroll_top??route.query.scroll_top)||0;const el=scrollContainer();if(el)el.scrollTop=top;}
async function changeShops(){saveMonitor();const loadingShops=load(true);try{await apiClient.post('/api/user-preferences',{key:preferenceKey.value,value:{shops:selectedShops.value}});}catch{ElMessage.warning('店铺选择暂未保存到账户，请稍后重试');}await loadingShops;}

function openDetail(row){const saved=saveMonitor();router.push({name:'sku-traffic-detail',query:{...monitorContextQuery(saved),shop_id:String(row.shop_id),sku:row.sku,date:state.date,range_days:String(applied.value.range_days)}});}
const state=reactive({rows:[],shops:[],days:[],coverage:[],total:0,date:'',latest_available_date:null,report_end_date:'',selected_count:0,range_from:'',shop_id:'all',page:1,pageSize:30});
const form=reactive({query:'',search_by:'all',exact:true,range_days:7,sort_key:'total_views',sort_order:'desc'});
const selectedShops=ref(String(route.query.shops||'').split(',').filter(Boolean));
const view=ref(String(route.query.view||'all')),tagFilter=ref([]),groupBy=ref(String(route.query.group_by||'sku'));
const tagOptions=ref([...DEFAULT_TRAFFIC_TAGS]);
function openWatchEditor(row,focus=false){watchEditor.value={...row,tags:[...new Set([...trafficRowTags(row),...(focus?[FOCUSED_TRAFFIC_TAG]:[])])]};}
function saveWatchEditor(){const row=watchEditor.value;return saveWatch(row,{focused:row.tags.includes(FOCUSED_TRAFFIC_TAG),tags:row.tags.filter(tag=>tag!==FOCUSED_TRAFFIC_TAG)});}
const watchEditor=ref(null),watchSaving=ref(false);
const rules=ref([]),applied=ref({...form,filters:'[]'}),datePinned=ref(false);
function restoreMonitorRoute(query=Object.keys(route.query).length?route.query:savedMonitor()){
 selectedShops.value=String(query.shops||'').split(',').filter(Boolean);
 view.value=String(query.view||'all');try{tagFilter.value=query.tags?JSON.parse(query.tags):query.tag?[String(query.tag)]:[];if(!Array.isArray(tagFilter.value))tagFilter.value=[];}catch{tagFilter.value=[];}groupBy.value=String(query.group_by||'sku');
 Object.assign(form,{query:'',search_by:'all',exact:true,range_days:7,sort_key:'total_views',sort_order:'desc'});rules.value=[];datePinned.value=false;
for(const k of ['query','search_by','sort_key','sort_order'])if(typeof query[k]==='string')form[k]=query[k];
if([1,7,15,30].includes(Number(query.range_days)))form.range_days=Number(query.range_days);
if(['0','false'].includes(String(query.exact)))form.exact=false;
try{if(query.filters){const parsed=JSON.parse(query.filters);if(Array.isArray(parsed))rules.value=parsed;}}catch{}
applied.value={...form,filters:JSON.stringify(rules.value)};
if(query.date){state.date=String(query.date);datePinned.value=true;}
state.page=Math.max(1,Number(query.page)||1);
state.pageSize=Math.min(100,Math.max(1,Number(query.pageSize)||30));
}
restoreMonitorRoute();
function querySignature(query){return JSON.stringify(Object.entries(query).filter(([key,value])=>key!=='scroll_top'&&value!==undefined&&value!==null).map(([key,value])=>[key,String(value)]).sort(([a],[b])=>a.localeCompare(b)));}
watch(()=>route.query,()=>{if(route.name==='sku-traffic-monitor'&&querySignature(route.query)!==querySignature(monitorQuery())){restoreMonitorRoute();void load().then(restoreScroll);}});
const advanced=ref(false),syncDrawer=ref(false);
const visibleDays=computed(()=>state.days.filter(day=>day>=state.range_from&&day<=state.date));
const selectedShopRows=computed(()=>state.shops.filter(shop=>!selectedShops.value.length||selectedShops.value.includes(String(shop.id))));
const coverageCells=computed(()=>selectedShopRows.value.flatMap(shop=>visibleDays.value.map(date=>({shop,date,record:state.coverage.find(c=>String(c.shop_id)===String(shop.id)&&c.date_key===date)}))));
const completeCount=computed(()=>coverageCells.value.filter(c=>c.record?.status==='complete').length);
const partialCount=computed(()=>coverageCells.value.filter(c=>c.record?.status==='partial').length);
const rowGroups=computed(()=>{if(groupBy.value!=='inventory')return [{id:'all',label:'',rows:state.rows}];const groups=new Map();for(const row of state.rows){const id=row.inventory_group||`sku:${row.shop_id}:${row.sku}`;if(!groups.has(id))groups.set(id,{id,label:row.inventory?.find(i=>String(i.id)===id)?.name||'未关联库存',inventory:row.inventory?.find(i=>String(i.id)===id),rows:[]});groups.get(id).rows.push(row);}return [...groups.values()];});
function coverageLabel(record){return {complete:'完整',partial:'部分',pending:'采集中',failed:'失败'}[record?.status]||'缺失';}
function monitorQuery(){return {...applied.value,shops:selectedShops.value.join(','),view:view.value,tags:JSON.stringify(tagFilter.value),group_by:groupBy.value,date:datePinned.value?state.date:undefined,page:state.page,pageSize:state.pageSize};}
function goCollect(shop,date=state.date){if(!shop){syncDrawer.value=true;return;}router.push(dailyCollectionRoute(shop.id,date,saveMonitor()));}
function collectInterval(){if(selectedShopRows.value.length!==1){ElMessage.info('请先选择一家店铺，再补齐当前区间');return;}router.push(intervalCollectionRoute(selectedShopRows.value[0].id,state.date,applied.value.range_days,saveMonitor()));}
async function saveWatch(row,patch){if(watchSaving.value)return;watchSaving.value=true;try{await saveSkuTrafficWatch({shop_id:row.shop_id,sku:row.sku,focused:!!row.focused,tag:row.tag||'',note:row.note||'',...patch});watchEditor.value=null;await load();}catch(e){ElMessage.error(e.message||'关注保存失败');}finally{watchSaving.value=false;}}
const loading=ref(false),error=ref(''),chartGroup=ref('rates');
let revision=0,disposed=false,initialized=false;
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
 if(!initialized)return;
 if(reset)state.page=1;
 try{sessionStorage.setItem(sessionKey.value,JSON.stringify({...monitorQuery(),scroll_top:reset?0:(savedMonitor().scroll_top??route.query.scroll_top??0)}));}catch{}
 const ticket=++revision;loading.value=true;error.value='';
 try{
  if(route.name==='sku-traffic-monitor'&&querySignature(route.query)!==querySignature(monitorQuery()))await router.replace({name:'sku-traffic-monitor',query:{...Object.fromEntries(Object.entries(monitorQuery()).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)])),scroll_top:String(savedMonitor().scroll_top||0)}});
  if(ticket!==revision||disposed)return;
  const data=await getSkuTrafficDaily({...applied.value,date:datePinned.value?state.date:undefined,date_mode:'latest_report_day',shop_ids:selectedShops.value.join(',')||undefined,view:view.value,tags:JSON.stringify(tagFilter.value),group_by:groupBy.value,shop_id:'all',include_series:1,include_progress:1,series_format:'matrix',page:state.page,pageSize:state.pageSize});
  if(ticket!==revision||disposed)return;
  tagOptions.value=[...new Set([...DEFAULT_TRAFFIC_TAGS,...(data.tag_options||[])])];
  Object.assign(state,{rows:(data.rows||[]).map(row=>({...row,series:trafficRowSeries(row,data)})),shops:state.shops.length?state.shops:data.shops||[],days:data.days||[],coverage:data.coverage||[],total:data.total||0,date:data.date||state.date,latest_available_date:data.latest_available_date||null,report_end_date:data.report_end_date||'',range_from:data.range_from||data.date,selected_count:Number(data.selected_count||0)});
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
let refreshTimer;
function startRefresh(){window.clearInterval(refreshTimer);refreshTimer=window.setInterval(()=>{if(!loading.value)void load();},60000);}
async function initialize(){
 const scope=sessionKey.value;
 try{
  const [data,preference]=await Promise.all([getSkuTrafficDaily({metadata_only:1}),apiClient.get(`/api/user-preferences?key=${preferenceKey.value}`,{noCache:true}).catch(()=>null)]);
  if(scope!==sessionKey.value||disposed)return;
  state.shops=data.shops||[];tagOptions.value=[...new Set([...DEFAULT_TRAFFIC_TAGS,...(data.tag_options||[])])];
  selectedShops.value=preferredMonitorShops(state.shops,selectedShops.value.length?selectedShops.value:preference?.value?.shops);
  initialized=true;await load();await restoreScroll();startRefresh();
 }catch(e){if(scope===sessionKey.value)error.value=e.message||'店铺读取失败';}
}
onMounted(initialize);
watch(sessionKey,()=>{initialized=false;revision++;state.shops=[];state.rows=[];restoreMonitorRoute(savedMonitor());if(route.name==='sku-traffic-monitor')void router.replace({name:'sku-traffic-monitor',query:{}});void initialize();});
onActivated(()=>{if(initialized){void load().then(restoreScroll);startRefresh();}});
onBeforeRouteLeave(()=>{saveMonitor();});
onDeactivated(()=>{window.clearInterval(refreshTimer);});
onBeforeUnmount(()=>{disposed=true;revision++;window.clearInterval(refreshTimer);});
</script>
<template>
 <div ref="monitorRoot" class="sku-traffic-monitor">
  <ErpPageHeader compact title="SKU 流量监控" description="按店铺与库存查看每日流量，标记重点SKU并补齐缺失日期"><template #actions><div class="coverage-compact"><el-button plain @click="syncDrawer=true">查看数据覆盖</el-button><span>完整 {{completeCount}} / {{coverageCells.length}} {{selectedShopRows.length===1?'天':'店铺日'}}</span><span v-if="partialCount">部分 {{partialCount}}</span><span v-if="coverageCells.length-completeCount-partialCount" class="coverage-missing">待补齐 {{coverageCells.length-completeCount-partialCount}}</span></div><el-button type="primary" @click="collectInterval" :disabled="loading||!state.date">补齐当前区间</el-button><el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button></template></ErpPageHeader>
  <section class="filters">
   <div class="main-toolbar">
    <el-select v-model="selectedShops" multiple collapse-tags collapse-tags-tooltip clearable placeholder="全部店铺" aria-label="店铺多选" class="shop-select" @change="changeShops"><el-option v-for="shop in state.shops" :key="shop.id" :label="shop.name" :value="String(shop.id)"/></el-select>
    <el-select v-model="form.range_days" aria-label="统计范围" class="range-select" @change="search()"><el-option label="单日" :value="1"/><el-option label="近7天" :value="7"/><el-option label="近15天" :value="15"/><el-option label="近30天" :value="30"/></el-select>
    <el-select v-model="form.search_by" aria-label="搜索字段" class="field-select"><el-option label="全部字段" value="all"/><el-option label="库存ID" value="inventory_id"/><el-option label="库存编号" value="inventory"/><el-option label="库存名称" value="inventory_name"/><el-option label="SKU" value="sku"/><el-option label="货号" value="offer_id"/><el-option label="商品名称" value="product_name"/></el-select>
    <el-input v-model="form.query" class="keyword-input" :placeholder="form.search_by==='inventory_id'?'输入库存ID，跨店铺查看绑定SKU':'搜索库存、SKU、货号或名称'" clearable @keyup.enter="search"/>
    <el-button type="primary" :icon="Search" @click="search">搜索</el-button>
    <el-radio-group v-model="view" class="inline-views" @change="load(true)"><el-radio-button value="all">全部SKU</el-radio-button><el-radio-button value="focused">★ 重点关注</el-radio-button><el-radio-button value="bound">已关联库存</el-radio-button><el-radio-button value="unbound">未关联库存</el-radio-button></el-radio-group>
    <el-select v-model="tagFilter" multiple filterable collapse-tags collapse-tags-tooltip clearable placeholder="标签组（可多选）" aria-label="标签组筛选" class="tag-filter" @change="load(true)"><el-option v-for="tag in tagOptions" :key="tag" :label="tag" :value="tag"/></el-select>
    <el-radio-group v-model="groupBy" @change="load(true)"><el-radio-button value="sku">按SKU</el-radio-button><el-radio-button value="inventory">按库存分组</el-radio-button></el-radio-group>
    <el-button :type="advanced||rules.length?'primary':'default'" plain @click="advanced=!advanced">更多筛选{{rules.length?' · '+rules.length:''}}</el-button>
    <el-select v-model="form.sort_key" class="sort-select" aria-label="排序指标" @change="search"><el-option v-for="[key,label] in metricOptions" :key="key" :label="label" :value="key"/></el-select>
    <el-button class="direction-button" @click="form.sort_order=form.sort_order==='desc'?'asc':'desc';search()">{{form.sort_order==='desc'?'↓ 降序':'↑ 升序'}}</el-button>

   </div>


  </section>

   <el-dialog v-model="advanced" title="组合筛选" width="min(660px, 94vw)" top="8vh" append-to-body><div class="advanced-search">
    <div class="advanced-heading"><span>同时满足以下条件（AND）</span><el-button link @click="clear">重置筛选</el-button></div>
    <div class="quick-filters"><span>常用</span><el-button size="small" @click="potential">高浏览下单率 · 低曝光</el-button><small>浏览下单率 &gt; 8%，总曝光 &lt; 20；阈值可编辑</small></div>
    <div class="filter-row metric-rules"><div v-for="(rule,index) in rules" :key="index" class="metric-rule"><el-select v-model="rule.metric" aria-label="筛选指标"><el-option v-for="[key,label] in metricOptions" :key="key" :label="label" :value="key"/></el-select><el-select v-model="rule.op" class="operator" aria-label="比较条件"><el-option v-for="[key,label] in comparisons" :key="key" :label="label" :value="key"/></el-select><el-input-number v-model="rule.value" :min="0" :controls="false" placeholder="数值" aria-label="指标阈值"/><el-button :icon="Delete" text aria-label="删除条件" @click="rules.splice(index,1)"/></div><el-button :icon="Plus" :disabled="rules.length>=8" @click="addRule">添加条件</el-button></div>
    <div class="advanced-footer"><el-checkbox v-model="form.exact">精确匹配</el-checkbox><span>历史回看</span><el-select v-model="state.date" aria-label="历史截至日期" class="date-select" @change="datePinned=true;load(true)"><el-option v-for="day in [...state.days].reverse()" :key="day" :label="day" :value="day"/></el-select><el-button v-if="datePinned" link @click="showLatest">回到最新数据</el-button><el-button type="primary" size="small" @click="search">应用筛选</el-button></div>
   </div></el-dialog>
  <div class="report-context"><span>来源：Ozon插件采集 · {{state.range_from}} — {{state.date}} · {{state.total.toLocaleString()}} {{groupBy==='inventory'?'个库存分组':'个SKU'}}</span><span v-if="applied.search_by==='inventory_id'&&applied.query">库存ID {{applied.query}} · 仅显示已绑定SKU</span></div>

  <p v-if="error" class="inline-error">{{error}}</p><p v-else-if="state.latest_available_date&&state.date>state.latest_available_date" class="data-gap-note">{{state.date}} 尚未采集 · 最近有数据：{{state.latest_available_date}}</p>
  <div v-loading="loading" class="records-scroll">
   <div class="sku-records" role="table" aria-label="SKU逐行流量趋势">
    <div class="sku-record row-head" role="row"><span role="columnheader">店铺</span><span role="columnheader">商品 / SKU / 货号</span><span role="columnheader">关联库存</span><span role="columnheader">区间合计 · 不随悬浮改变</span><div role="columnheader" class="trend-heading"><div class="trend-heading-top"><span>每日趋势</span><span>纵轴：{{chartGroup==='rates'?'百分比 %':'次数 / 件数'}}</span></div>  <div class="row-chart-controls">
   <el-radio-group v-model="chartGroup" size="small"><el-radio-button value="rates">百分比趋势</el-radio-button><el-radio-button value="traffic">数量趋势</el-radio-button></el-radio-group>
   <div class="row-legend"><button v-for="[key,label,color] in chartOptions" :key="key" type="button" :class="{inactive:!visibleKeys.includes(key)}" :aria-pressed="visibleKeys.includes(key)" @click="toggleLine(key)"><i :style="{background:color}"/>{{label}}</button></div>

  </div>
</div></div>
    <template v-for="group in rowGroups" :key="group.id"><div v-if="groupBy==='inventory'" class="inventory-group-heading"><strong>{{group.inventory?.inventory_number||group.inventory?.code||'未关联库存'}} · {{group.label}}</strong><span>{{group.rows.length}} 个店铺SKU · 组合SKU可出现在多个关联库存下，指标不重复汇总</span></div>
    <article v-for="row in group.rows" :key="`${group.id}:${row.shop_id}:${row.sku}`" class="sku-record" role="row" :aria-label="`SKU ${row.sku}`">
     <div role="cell" class="row-shop">{{row.shop_name}}</div>
     <div role="cell" class="product-cell"><SkuTrafficProductImage :src="row.image_url||''" :alt="row.product_name||'商品主图'"/><div class="product-brief" :title="row.product_name" role="link" tabindex="0" :aria-label="`查看SKU ${row.sku} 明细`" @click="openDetail(row)" @keydown.enter.self="openDetail(row)"><strong><button class="focus-star" type="button" :class="{active:row.focused}" :aria-label="row.focused?'编辑关注与标签':'添加关注与标签'" :disabled="watchSaving" @click.stop="openWatchEditor(row,true)">{{row.focused?'★':'☆'}}</button>{{shortName(row.product_name)}}</strong><div v-if="trafficRowTags(row).length" class="watch-tags"><el-tag v-for="tag in trafficRowTags(row)" :key="tag" size="small">{{tag}}</el-tag></div><span v-if="row.note" :title="row.note">备注：{{row.note}}</span><span>SKU {{row.sku}}</span><span :title="row.offer_id">货号 {{row.offer_id||'—'}}</span><div class="product-actions"><button type="button" class="detail-link" @click.stop="openDetail(row)">查看明细</button><button type="button" class="detail-link" @click.stop="openWatchEditor(row)">标签 / 备注</button></div></div></div>
     <div role="cell" class="inventory-brief" :title="inventoryLabel(row)"><template v-if="row.inventory?.length"><strong>{{row.inventory.map(p=>`ID ${p.id} · ${p.inventory_number||p.code||''}`).join(' / ')}}</strong><span>{{row.inventory.map(p=>p.name).join(' / ')}}</span></template><span v-else class="muted">未关联库存</span></div>
     <div role="cell"><div class="row-metrics"><span v-for="[key,label] in metrics" :key="key">{{label}}<b>{{number(row.summary?.[key])}}</b></span><span v-for="[key,label] in rates" :key="key">{{rateLabel(key)}}<b>{{percent(row.summary?.[key])}}</b></span></div></div>
     <div role="cell" class="row-trend"><SkuTrafficTrendChart compact :tooltip-metrics="hoverMetrics" :series="row.series" :metrics="lineMetrics" :unit="chartGroup==='rates'?'%':''"/></div>
    </article></template>
    <div v-if="!state.rows.length" class="record-empty"><el-empty :description="error?'读取失败，请刷新重试':'暂无符合条件的日指标，可调整条件或补采日期。'"/></div>
   </div>
  </div>
  <el-dialog :model-value="!!watchEditor" title="SKU关注与标记" width="440px" @close="watchEditor=null"><template v-if="watchEditor"><p>{{watchEditor.shop_name}} · {{watchEditor.sku}}</p><el-select v-model="watchEditor.tags" multiple filterable allow-create default-first-option :reserve-keyword="false" :multiple-limit="12" placeholder="选择或输入标签，回车创建" aria-label="SKU标签" class="watch-tag-select"><el-option v-for="tag in [...new Set([...tagOptions,...watchEditor.tags])]" :key="tag" :label="tag" :value="tag"/></el-select><el-input v-model="watchEditor.note" type="textarea" maxlength="512" show-word-limit placeholder="记录关注原因或运营备注"/><p>可多选或输入自建标签，最多12个、每个80字。标签和备注在当前企业内按店铺、SKU共享。</p></template><template #footer><el-button @click="watchEditor=null">取消</el-button><el-button type="primary" :loading="watchSaving" @click="saveWatchEditor">保存</el-button></template></el-dialog>
  <el-drawer v-model="syncDrawer" title="逐店逐日补采" size="min(660px, 95vw)" append-to-body><p>完整 {{completeCount}} / {{coverageCells.length}} 个店铺日 · 部分 {{partialCount}} · 待补齐 {{coverageCells.length-completeCount-partialCount}}</p><p>选择缺失或部分采集的日期，去数据分析核对后台店铺并采集；完成后返回这里。完整表示该日报表分页完整；缺失不按0计算。日指标保留30天。</p><section v-for="shop in selectedShopRows" :key="shop.id" class="coverage-shop"><h3>{{shop.name}}</h3><div v-for="cell in coverageCells.filter(c=>c.shop.id===shop.id)" :key="cell.date" class="sync-day"><strong>{{cell.date}}</strong><div><span :class="'sync-kind-'+cell.record?.status">{{coverageLabel(cell.record)}}<template v-if="cell.record?.product_count!=null"> · {{cell.record.product_count}} SKU</template></span><small>{{cell.record?.message}}</small></div><el-button size="small" :disabled="cell.record?.status==='pending'" @click="goCollect(shop,cell.date)">{{cell.record?.status==='complete'?'重新采集':'去补采'}}</el-button></div></section></el-drawer>
  <PageFooterPagination v-if="!error" :page="state.page" :page-size="state.pageSize" :total="state.total" @update:page="state.page=$event;load()" @update:page-size="state.pageSize=$event;load(true)"/>
  <p class="muted">搜索曝光占比 = 搜索曝光 ÷ 总曝光；详情浏览率 = 浏览 ÷ 总曝光；浏览→下单率 = 下单件数 ÷ 详情浏览次数。浏览并非独立访客或广告点击，以上不是广告CTR；分母为0或缺数据时不计算。</p>
 </div>
</template>
<style scoped>
.tag-filter{width:170px}.coverage-compact{display:flex;align-items:center;flex-wrap:nowrap;gap:8px;font-size:12px;color:var(--erp-text-secondary)}.coverage-compact .el-button{font-size:12px}.coverage-missing{color:var(--el-color-warning)}.inventory-group-heading{padding:12px 16px;background:var(--erp-surface-alt);border-bottom:1px solid var(--erp-border);display:flex;gap:18px;font-size:12px}.inventory-group-heading span{color:var(--erp-text-secondary)}.focus-star{border:0;background:none;color:#8791a4;cursor:pointer;font-size:20px;padding:0 6px 0 0}.focus-star.active{color:#d9a027}.product-brief[role="link"]{cursor:pointer;border-radius:4px}.product-brief[role="link"]:focus-visible{outline:2px solid var(--el-color-primary)}.product-actions,.watch-tags{display:flex;align-items:center;gap:12px;white-space:normal!important}.watch-tags{gap:4px;flex-wrap:wrap}.watch-tag-select{width:100%;margin-top:12px}.main-toolbar :deep(.el-radio-button__inner){padding:8px 9px}.coverage-shop h3{font-size:14px}.el-dialog .el-input,.el-dialog .el-textarea{margin-top:14px}

.sku-traffic-monitor{display:flex;flex-direction:column;gap:12px;padding:14px;color:var(--erp-text)}.main-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px}.main-toolbar>*{flex-shrink:0}.sort-select{width:115px}.direction-button{padding:8px 10px}.advanced-search{max-height:65vh;overflow-y:auto;display:flex;flex-direction:column;gap:12px}.advanced-heading,.quick-filters,.advanced-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px}.advanced-heading>span,.quick-filters>span,.quick-filters>small{color:var(--erp-text-secondary)}.advanced-heading>.el-button{margin-left:auto}.backfill-status{color:var(--el-color-primary)}.browser-connection{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--erp-text-secondary)}.browser-connection strong{font-size:12px;color:var(--erp-text)}.connection-dot{width:6px;height:6px;border-radius:50%;background:#d6a143}.connection-dot.ready{background:#27b99c}.retention-note{margin-left:auto}.data-gap-note{margin:0;color:var(--erp-text-secondary);font-size:11px}.inline-error{color:var(--el-color-danger);font-size:12px;margin:0}.sync-summary{font-size:12px;line-height:1.8;margin-bottom:18px}.sync-summary p{color:var(--erp-text-secondary)}.sync-day{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--erp-border);font-size:12px}.sync-day>div{display:flex;flex-direction:column;gap:5px;text-align:right}.sync-day small{color:var(--erp-text-secondary)}.sync-kind-complete{color:#27b99c}.sync-kind-running,.sync-kind-publishing{color:var(--el-color-primary)}.sync-kind-stale{color:var(--el-color-warning)}.sync-kind-failed{color:var(--el-color-danger)}.sync-kind-queued,.sync-kind-missing{color:var(--erp-text-secondary)}.filters{background:var(--erp-surface);border:1px solid var(--erp-border);border-radius:10px;padding:12px}.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.filter-row+.filter-row{margin-top:10px}.shop-select{width:170px}.range-select{width:95px}.date-select{width:176px}.field-select{width:108px}.keyword-input{min-width:150px;max-width:240px;flex:1}.metric-rule,.sort-controls{display:flex;align-items:center;gap:5px}.metric-rule{padding:4px;background:var(--erp-surface-alt);border-radius:6px}.metric-rule>.el-select{width:190px}.metric-rule>.operator{width:64px}.metric-rule .el-input-number{width:100px}.sort-controls{margin-left:auto}.sort-controls>.el-select{width:170px}.sort-controls>.direction{width:118px}.report-context{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:10px;color:var(--erp-text-secondary);font-size:12px}.row-chart-controls{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:8px}.row-chart-controls :deep(.el-radio-button__inner){font-size:11px;padding:5px 9px}.trend-heading{min-width:0}.trend-heading-top{display:flex;justify-content:space-between;gap:10px}.trend-heading-top>span+span{font-size:10px;font-weight:400;color:var(--erp-text-secondary)}.row-legend{display:flex;flex-wrap:wrap;gap:6px 10px;font-weight:400}.row-legend button{font-size:10px!important}.row-legend button{display:flex;align-items:center;gap:5px;background:none;border:0;color:var(--erp-text);font-size:12px;cursor:pointer;padding:0}.row-legend i{height:8px;width:8px;border-radius:50%}.row-legend .inactive{opacity:.35}.records-scroll{overflow-x:auto;border:1px solid var(--erp-border);border-radius:8px;background:var(--erp-surface)}.sku-records{min-width:1240px}.sku-record{display:grid;grid-template-columns:110px minmax(280px,1fr) minmax(150px,.55fr) 220px minmax(420px,1.7fr);align-items:center;gap:14px;padding:8px 12px;min-height:128px;border-bottom:1px solid var(--erp-border)}.sku-record:last-child{border-bottom:0}.row-head{min-height:72px;background:var(--erp-surface-alt);font-size:12px;font-weight:600}.row-shop{font-size:12px;font-weight:600;line-height:1.5}.product-cell{display:flex;align-items:center;gap:12px;min-width:0}.product-brief{flex:1}.product-brief,.inventory-brief{display:flex;flex-direction:column;gap:5px;min-width:0;line-height:1.5}.product-brief strong,.inventory-brief strong{font-size:12px;font-weight:500}.product-brief span,.inventory-brief span{font-size:11px;color:var(--erp-text-secondary)}.product-brief>*,.inventory-brief>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-metrics{display:grid;grid-template-columns:1fr 1fr;gap:5px 10px;font-size:11px;margin-bottom:8px}.row-metrics span{display:flex;justify-content:space-between;gap:5px;color:var(--erp-text-secondary)}.row-metrics b{font-weight:500;color:var(--erp-text)}.detail-link{align-self:flex-start;padding:0;border:0;background:none;color:var(--el-color-primary);font-size:12px;cursor:pointer}.row-trend{min-width:0}.record-empty{padding:20px}.muted{font-size:12px;color:var(--erp-text-secondary)}.coverage-item{display:flex;justify-content:space-between;gap:10px;margin:8px 0}@media(max-width:1400px){.sort-controls{margin-left:0}}
</style>

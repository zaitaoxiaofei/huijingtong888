<script setup>
import {computed,ref,watch,onBeforeUnmount} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import ErpPageHeader from '../../components/ErpPageHeader.vue';
import SkuTrafficProductImage from '../../components/SkuTrafficProductImage.vue';
import SkuTrafficTrendChart from '../../components/SkuTrafficTrendChart.vue';
import {getSkuTrafficDaily} from '../../api/sellerAnalytics';
import {trafficRowSeries} from '../../utils/sku-traffic-row-series';
import {dailyMetricChange} from '../../utils/sku-traffic-detail';
import {SKU_TRAFFIC_OPERATION_METRICS,SKU_TRAFFIC_PRIMARY_RATE_KEYS} from '../../../../src/shared/sku-traffic-monitor-query';
const route=useRoute(),router=useRouter(),row=ref(null),series=ref([]),response=ref({}),loading=ref(false),error=ref('');
const rangeDays=ref([1,7,15,30].includes(Number(route.query.range_days))?Number(route.query.range_days):7);
const chartGroup=ref('rates');
const displayName=computed(()=>row.value?.inventory?.map(p=>p.name).filter(Boolean).join(' / ')||row.value?.product_name||'商品名称未同步');
const counts=SKU_TRAFFIC_OPERATION_METRICS.slice(0,5),rates=SKU_TRAFFIC_PRIMARY_RATE_KEYS.map(key=>SKU_TRAFFIC_OPERATION_METRICS.find(([k])=>k===key));
const hoverMetrics=[...counts.map(([key,label])=>({key,label,unit:''})),...rates.map(([key,label])=>({key,label:label.replace(/ ?%$/,''),unit:'%'}))];
const number=value=>value===null||value===undefined?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:2});
const percent=value=>value===null||value===undefined?'—':`${Number(value).toFixed(2)}%`;
const observed=computed(()=>series.value.filter(day=>day.available).length);
const missingDays=computed(()=>series.value.filter(day=>!day.available).map(day=>day.date_key));
const changes=computed(()=>counts.map(([key,label])=>({key,label,value:dailyMetricChange(series.value,key)})));
let revision=0,disposed=false;
async function load(){
 const ticket=++revision;loading.value=true;error.value='';row.value=null;series.value=[];
 try{
  if(!/^\d+$/.test(String(route.query.shop_id||''))||!String(route.query.sku||''))throw new Error('缺少店铺或SKU，请从SKU流量监控的“查看明细”打开。');
  const data=await getSkuTrafficDaily({shop_id:route.query.shop_id,query:route.query.sku,search_by:'sku',exact:1,date:route.query.date||undefined,range_days:rangeDays.value,include_series:1,series_format:'matrix',pageSize:1});
  if(disposed||ticket!==revision)return;
  response.value=data;row.value=data.rows?.[0]||null;series.value=row.value?trafficRowSeries(row.value,data):[];
 }catch(e){if(!disposed&&ticket===revision)error.value=e.message||'SKU明细读取失败';}
 finally{if(!disposed&&ticket===revision)loading.value=false;}
}
watch(()=>[route.query.shop_id,route.query.sku,route.query.date,rangeDays.value],load,{immediate:true});
onBeforeUnmount(()=>{disposed=true;revision++;});
</script>
<template>
 <div class="sku-detail" v-loading="loading">
  <ErpPageHeader compact title="SKU 分析明细" description="每日流量与转化"><template #actions><el-button @click="router.push('/sku-traffic-monitor')">返回列表</el-button><el-select v-model="rangeDays" class="detail-range" aria-label="明细统计范围"><el-option label="单日" :value="1"/><el-option label="近7天" :value="7"/><el-option label="近15天" :value="15"/><el-option label="近30天" :value="30"/></el-select><el-button @click="load">刷新数据</el-button></template></ErpPageHeader>
  <el-alert v-if="error" type="error" :title="error" :closable="false"/>
  <template v-if="row">
   <section class="product-profile">
    <SkuTrafficProductImage hero :src="row.image_url||''" :alt="row.product_name||'商品主图'"/>
    <div class="profile-copy">
     <div class="profile-eyebrow"><span class="shop-label">{{row.shop_name}}</span><span>SKU 流量档案</span></div>
     <h2 :title="displayName">{{displayName}}</h2>
     <p class="original-title" :title="row.product_name">{{row.product_name||'商品名称未同步'}}</p>
     <div class="product-identifiers"><span>SKU <b>{{row.sku}}</b></span><span>货号 <b>{{row.offer_id||'—'}}</b></span><span>库存 <b>{{row.inventory?.map(p=>`ID ${p.id} · ${p.inventory_number||p.code||''}`).join(' / ')||'未关联'}}</b></span></div>
     <div class="profile-period"><span>{{response.range_from}} — {{response.date}}</span><span class="coverage-pill" :class="{partial:observed<series.length}">{{observed}} / {{series.length}} 天有记录</span></div>
    </div>
   </section>
   <div v-if="observed<series.length" class="coverage-notice"><i/>{{series.length-observed}} 天尚无记录，合计仅含已采数据，缺失不计为零。<span :title="missingDays.join('、')">查看缺失日期</span></div>
   <section class="period-overview" aria-label="区间合计">
    <div class="section-title"><h3>区间表现</h3><span>所选区间合计 · 不随悬浮改变</span></div>
    <div class="metric-strip"><div v-for="([key,label],index) in counts" :key="key" class="metric-tile" :style="{'--metric-color':['#4c9bff','#27c5a3','#f5b84c','#b28aff','#f47987'][index]}"><span><i/>{{label}}</span><strong>{{number(row.summary?.[key])}}</strong></div></div>
   </section>
   <div class="analysis-grid">
    <section class="detail-panel focus-chart">
     <div class="section-title"><div><h3>每日趋势</h3><p>悬浮某一天，查看当天各项数值</p></div><el-radio-group v-model="chartGroup" size="small"><el-radio-button value="traffic">流量与下单</el-radio-button><el-radio-button value="rates">转化率</el-radio-button></el-radio-group></div>
     <div class="axis-caption">纵轴：{{chartGroup==='rates'?'比例 %':'次数 / 件数'}} · 横轴：报表日期</div><SkuTrafficTrendChart :tooltip-metrics="hoverMetrics" :series="series" :metrics="chartGroup==='traffic'?counts:rates" :unit="chartGroup==='rates'?'%':''"/>
    </section>
    <aside class="detail-panel conversion-panel">
     <div class="section-title"><h3>区间转化</h3><span>已采日期</span></div>
     <div v-for="[key,label] in rates" :key="key" class="conversion-item"><span>{{label.replace(/ ?%$/,'')}}</span><strong>{{percent(row.summary?.[key])}}</strong><div class="rate-track"><i v-if="row.summary?.[key]!==null&&row.summary?.[key]!==undefined" :style="{width:Math.max(0,Math.min(100,Number(row.summary[key])))+'%'}"/></div></div>
     <p class="metric-note">搜索占比 = 搜索曝光 / 总曝光；浏览率 = 详情浏览 / 总曝光；浏览下单率 = 下单件数 / 详情浏览次数。缺少分母时不计算。</p>
    </aside>
   </div>
   <section class="detail-panel movement-panel"><div class="section-title"><h3>首末有效日变化</h3><span>各指标按自身有效记录比较</span></div><div class="movement-grid"><div v-for="item in changes" :key="item.key" class="movement-item"><span class="movement-label">{{item.label}}</span><template v-if="item.value"><strong :class="item.value.change>0?'rise':item.value.change<0?'fall':''">{{item.value.change>0?'+':''}}{{number(item.value.change)}}<small v-if="item.value.percent!==null">{{item.value.percent>0?'+':''}}{{percent(item.value.percent)}}</small></strong><span>{{number(item.value.first)}} → {{number(item.value.last)}}</span><small>{{item.value.from.slice(5)}} — {{item.value.to.slice(5)}}</small></template><span v-else class="movement-empty">待积累两天有效记录</span></div></div></section>
   <section class="detail-panel daily-panel"><div class="section-title"><h3>逐日数据</h3><span>{{response.range_from}} — {{response.date}} · 北京时间</span></div><div class="daily-scroll"><table class="daily-table"><thead><tr><th>日期</th><th>采集状态</th><th v-for="[key,label] in [...counts,...rates]" :key="key">{{label.replace(/ ?%$/,'')}}</th></tr></thead><tbody><tr v-for="day in series" :key="day.date_key" :class="{unavailable:!day.available}"><td>{{day.date_key}}</td><td><span class="day-status" :class="{available:day.available}"><i/>{{day.available?'有记录':'未采集'}}</span></td><td v-for="[key] in counts" :key="key">{{number(day[key])}}</td><td v-for="[key] in rates" :key="key">{{percent(day[key])}}</td></tr></tbody></table></div></section>
   <p class="page-footnote">来源：Ozon插件采集的日指标。浏览次数不是独立访客或广告点击；浏览下单率采用件数口径，不是按人数计算的购买转化率。首末变化不代表广告增量。</p>
  </template>
  <el-empty v-else-if="!loading&&!error" description="该SKU在所选区间暂无日记录，可返回列表调整日期或补采。"/>
 </div>
</template>
<style scoped>
.sku-detail{display:flex;flex-direction:column;gap:20px;padding:12px 20px 28px;color:var(--erp-text);max-width:1800px;margin:0 auto}.sku-detail :deep(.erp-page-header){padding:4px 0}.detail-range{width:110px}.product-profile{display:flex;align-items:center;gap:24px;padding:24px;background:linear-gradient(120deg,var(--erp-surface-alt),var(--erp-surface) 70%);border:1px solid var(--erp-border);border-radius:14px}.profile-copy{min-width:0;flex:1}.profile-eyebrow{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--erp-text-secondary)}.shop-label{padding:4px 9px;border:1px solid var(--erp-border-strong,var(--erp-border));border-radius:5px;color:var(--erp-text)}.profile-copy h2{margin:12px 0 6px;font-size:21px;line-height:1.4;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.original-title{margin:0;color:var(--erp-text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.product-identifiers{display:flex;gap:10px 22px;flex-wrap:wrap;margin-top:16px;font-size:11px;color:var(--erp-text-secondary)}.product-identifiers b{font-weight:500;color:var(--erp-text);margin-left:6px;overflow-wrap:anywhere}.profile-period{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-top:14px;font-size:12px;color:var(--erp-text-secondary)}.coverage-pill{font-size:11px;border-radius:4px;padding:3px 7px;background:#27c5a314;color:#27b99c}.coverage-pill.partial{background:#f5b84c14;color:#d6a143}.section-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.section-title h3{font-size:14px;font-weight:600;margin:0}.section-title>span,.section-title p{font-size:11px;color:var(--erp-text-secondary);margin:6px 0 0}.metric-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.metric-tile{border:1px solid var(--erp-border);background:var(--erp-surface);border-radius:10px;padding:16px 18px}.metric-tile>span{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--erp-text-secondary)}.metric-tile i{height:7px;width:7px;border-radius:50%;background:var(--metric-color)}.metric-tile strong{display:block;margin-top:12px;font-size:27px;line-height:1.2;font-weight:600;letter-spacing:-.7px;font-variant-numeric:tabular-nums}.detail-panel{padding:20px;background:var(--erp-surface);border:1px solid var(--erp-border);border-radius:12px;min-width:0}.analysis-grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:16px;align-items:stretch}.focus-chart :deep(.plot svg){height:260px;min-height:0}.axis-caption{font-size:10px;color:var(--erp-text-secondary);margin-bottom:10px}.focus-chart :deep(.legend){margin-bottom:12px}.focus-chart :deep(.trend-chart>p){margin-top:10px;font-size:11px}.conversion-panel{display:flex;flex-direction:column}.conversion-item{padding:14px 0;border-bottom:1px solid var(--erp-border)}.conversion-item>span{font-size:12px;color:var(--erp-text-secondary)}.conversion-item strong{display:block;font-size:23px;font-weight:600;margin:8px 0 10px;font-variant-numeric:tabular-nums}.rate-track{height:3px;border-radius:4px;background:var(--erp-surface-alt);overflow:hidden}.rate-track i{height:100%;display:block;background:#4c9bff;border-radius:4px}.metric-note{font-size:11px;color:var(--erp-text-secondary);line-height:1.8;margin:16px 0 0}.movement-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:18px}.movement-item{display:flex;flex-direction:column;gap:8px;font-size:12px;border-right:1px solid var(--erp-border);padding-right:12px;min-width:0}.movement-item:last-child{border-right:0}.movement-label,.movement-item>span,.movement-item>small{color:var(--erp-text-secondary)}.movement-item>strong{display:flex;align-items:baseline;gap:8px;font-size:20px;flex-wrap:wrap}.movement-item small{font-size:10px;font-weight:400}.rise{color:#27b99c}.fall{color:#ed8491}.movement-empty{font-size:11px;padding:12px 0}.daily-panel{padding:20px 0 0;overflow:hidden}.daily-panel>.section-title{padding:0 20px}.daily-scroll{overflow:auto;max-height:600px}.daily-table{width:100%;min-width:1100px;border-collapse:collapse;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}.daily-table th,.daily-table td{padding:13px 18px;text-align:right;border-bottom:1px solid var(--erp-border)}.daily-table th:first-child,.daily-table td:first-child{text-align:left}.daily-table th{position:sticky;top:0;background:var(--erp-surface-alt);color:var(--erp-text-secondary);font-size:11px;font-weight:500;z-index:1}.daily-table tr:hover td{background:var(--erp-surface-alt)}.daily-table tbody tr:last-child td{border-bottom:0}.unavailable td{color:var(--erp-text-secondary)}.day-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--erp-text-secondary)}.day-status i,.coverage-notice>i{height:5px;width:5px;background:currentColor;border-radius:50%;flex-shrink:0}.day-status.available{color:#27b99c}.coverage-notice{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:6px;font-size:12px;color:#d6a143;background:#f5b84c0c}.coverage-notice>span{margin-left:auto;text-decoration:underline;cursor:help;flex-shrink:0}.page-footnote{font-size:11px;color:var(--erp-text-secondary);line-height:1.8;margin:0}@media(min-width:1600px){.focus-chart :deep(.plot svg){height:280px}}@media(max-width:1100px){.analysis-grid{grid-template-columns:minmax(0,1fr)}.conversion-panel{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.conversion-panel>.section-title,.conversion-panel>.metric-note{grid-column:1/-1}.conversion-panel>.section-title{margin-bottom:0}.metric-strip{gap:8px}.metric-tile{padding:14px 12px}.metric-tile strong{font-size:23px}.movement-grid{gap:10px}}@media(max-width:767px){.sku-detail{padding:8px 12px 24px;gap:16px}.product-profile{padding:16px;gap:14px;align-items:flex-start}.profile-copy h2{font-size:17px}.product-identifiers{gap:6px;flex-direction:column;margin-top:12px}.profile-period{gap:8px;font-size:11px}.metric-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.detail-panel{padding:16px}.section-title{align-items:flex-start;flex-wrap:wrap;gap:8px}.analysis-grid{gap:12px}.conversion-panel{display:flex;gap:0}.movement-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.movement-item{border-right:0}.coverage-notice{align-items:flex-start;line-height:1.7;flex-wrap:wrap}.coverage-notice>span{margin-left:0}.coverage-notice>i{margin-top:8px}}
</style>

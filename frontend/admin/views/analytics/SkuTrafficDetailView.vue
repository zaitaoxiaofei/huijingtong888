<script setup>
import {computed,ref,watch,onBeforeUnmount} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import ErpPageHeader from '../../components/ErpPageHeader.vue';
import SkuTrafficTrendChart from '../../components/SkuTrafficTrendChart.vue';
import {getSkuTrafficDaily} from '../../api/sellerAnalytics';
import {trafficRowSeries} from '../../utils/sku-traffic-row-series';
import {dailyMetricChange} from '../../utils/sku-traffic-detail';
import {SKU_TRAFFIC_OPERATION_METRICS} from '../../../../src/shared/sku-traffic-monitor-query';
const route=useRoute(),router=useRouter(),row=ref(null),series=ref([]),response=ref({}),loading=ref(false),error=ref('');
const rangeDays=ref([1,7,15].includes(Number(route.query.range_days))?Number(route.query.range_days):7);
const counts=SKU_TRAFFIC_OPERATION_METRICS.slice(0,5),rates=SKU_TRAFFIC_OPERATION_METRICS.slice(5,8);
const number=value=>value===null||value===undefined?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:2});
const percent=value=>value===null||value===undefined?'—':`${Number(value).toFixed(2)}%`;
const observed=computed(()=>series.value.filter(day=>day.available).length);
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
  <ErpPageHeader compact title="SKU 分析明细" description="单个SKU的每日流量、转化和变化明细"><template #actions><el-button @click="router.push('/sku-traffic-monitor')">返回SKU列表</el-button><el-select v-model="rangeDays" style="width:110px" aria-label="明细统计范围"><el-option label="单日" :value="1"/><el-option label="近7天" :value="7"/><el-option label="近15天" :value="15"/></el-select><el-button @click="load">刷新</el-button></template></ErpPageHeader>
  <el-alert v-if="error" type="error" :title="error" :closable="false"/>
  <template v-if="row">
   <section class="detail-card identity"><strong>{{row.product_name||'商品名称未同步'}}</strong><span>店铺：{{row.shop_name}} · SKU：{{row.sku}} · 货号：{{row.offer_id||'—'}}</span><span>关联库存：{{row.inventory?.map(p=>`${p.inventory_number||p.code||'#'+p.id} ${p.name}`).join('；')||'未关联库存'}}</span><span>{{response.range_from}} 至 {{response.date}} · {{observed}} / {{series.length}} 天有日记录</span></section>
   <el-alert v-if="observed<series.length" type="warning" title="区间存在未采集日期，合计仅包含已采到的数据；缺失日期不按零计算。" :closable="false"/>
   <section class="detail-card"><h3>区间合计与转化率</h3><p class="muted">固定统计所选区间，不随鼠标悬浮改变。</p><div class="summary-metrics"><div v-for="[key,label] in counts" :key="key"><span>{{label}}</span><strong>{{number(row.summary?.[key])}}</strong></div><div v-for="[key,label] in rates" :key="key"><span>{{label.replace(' %','')}}</span><strong>{{percent(row.summary?.[key])}}</strong></div></div></section>
   <section class="detail-card"><h3>每日流量趋势</h3><SkuTrafficTrendChart :series="series" :metrics="counts"/></section>
   <section class="detail-card"><h3>每日转化率趋势</h3><SkuTrafficTrendChart :series="series" :metrics="rates" unit="%"/></section>
   <section class="detail-card"><h3>首末有效日对比</h3><p class="muted">分别比较每项指标首个与最后一个有数据的日期；用于观察变化，不代表广告带来的增量。</p><div class="changes"><div v-for="item in changes" :key="item.key"><strong>{{item.label}}</strong><template v-if="item.value"><span>{{item.value.from}} → {{item.value.to}}</span><span>{{number(item.value.first)}} → {{number(item.value.last)}} · {{item.value.change>0?'+':''}}{{number(item.value.change)}}<template v-if="item.value.percent!==null">（{{item.value.percent>0?'+':''}}{{percent(item.value.percent)}}）</template><template v-else>（起始值为0，不计算增幅）</template></span></template><span v-else>至少需要两天该指标的有效记录</span></div></div></section>
   <section class="detail-card"><h3>逐日明细</h3><div class="daily-scroll"><table class="daily-table"><thead><tr><th>日期</th><th>记录状态</th><th v-for="[key,label] in [...counts,...rates]" :key="key">{{label.replace(' %','')}}</th></tr></thead><tbody><tr v-for="day in series" :key="day.date_key"><td>{{day.date_key}}</td><td>{{day.available?'有记录':'未采集'}}</td><td v-for="[key] in counts" :key="key">{{number(day[key])}}</td><td v-for="[key] in rates" :key="key">{{percent(day[key])}}</td></tr></tbody></table></div></section>
   <p class="muted">详情浏览不是广告点击，下单件数不是订单数。单日转化率沿用官方值；区间转化率按已采到的下单、加购和曝光量计算。所有日期按北京时间展示。</p>
  </template>
  <el-empty v-else-if="!loading&&!error" description="该SKU在所选区间暂无日记录，可返回列表调整日期或补采。"/>
 </div>
</template>
<style scoped>
.sku-detail{display:flex;flex-direction:column;gap:14px;padding:14px;color:var(--erp-text)}.detail-card{padding:16px;background:var(--erp-surface);border:1px solid var(--erp-border);border-radius:8px;min-width:0}.detail-card h3{font-size:14px;margin:0 0 12px}.identity{display:flex;flex-direction:column;gap:8px;font-size:12px;line-height:1.7}.identity strong{font-size:15px}.identity span{overflow-wrap:anywhere;color:var(--erp-text-secondary)}.muted{font-size:12px;color:var(--erp-text-secondary);line-height:1.7;margin:0 0 10px}.summary-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.summary-metrics div{display:flex;flex-direction:column;gap:8px}.summary-metrics span{font-size:12px;color:var(--erp-text-secondary)}.summary-metrics strong{font-size:19px}.changes{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;font-size:12px}.changes>div{display:flex;flex-direction:column;gap:8px}.changes span{color:var(--erp-text-secondary)}.daily-scroll{overflow-x:auto}.daily-table{width:100%;min-width:1060px;border-collapse:collapse;font-size:12px;white-space:nowrap}.daily-table th,.daily-table td{padding:12px 10px;text-align:right;border-bottom:1px solid var(--erp-border)}.daily-table th:first-child,.daily-table td:first-child{text-align:left}.daily-table th{color:var(--erp-text-secondary);font-weight:500}@media(max-width:900px){.summary-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>

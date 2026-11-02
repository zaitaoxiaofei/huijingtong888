<script setup>
import {computed,onBeforeUnmount,onMounted,ref} from 'vue';
import {useRouter} from 'vue-router';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {shanghaiDateKey} from '../../utils/shanghai-date.js';
import {useAuthStore} from '../../stores/auth.js';
import {canAccessPage,hasPermission} from '../../../../src/shared/permissions.js';
const router=useRouter(),auth=useAuthStore(),data=ref({metrics:{}}),loading=ref(false),error=ref('');
let generation=0,financeGeneration=0,timer=0,disposed=false,attempt=0;const financeError=ref('');const financeMetrics=ref({});
const fields=computed(()=>[
 ...(data.value.financial?[['today_profit','今日利润','money']]:[]),
 ['today_revenue','今日有效营业额','money'],['today_orders','今日有效订单','单'],['today_cancelled','今日取消','单'],['today_returns','今日退件','件'],['ad_roas','广告回报 ROAS','ratio'],['month_quantity','当月销售件数','件'],['month_orders','当月有效订单','单'],
 ...(data.value.financial?[['month_revenue','当月营业额','money'],['month_profit','当月利润','money'],['month_purchase_amount','当月实际采购','money'],['month_ad_spend','当月广告花费','money'],['inventory_total_value','库存占用金额（含在途）','money']]:[]),
 ['return_rate','当月退货率','percent'],['cancel_rate','当月取消率','percent']
]);
function display(key,type){const value=financeMetrics.value[key]??data.value.metrics?.[key];if(value==null||value==='')return '—';const n=Number(value);if(!Number.isFinite(n))return '—';if(type==='percent')return `${(n*100).toFixed(1)}%`;if(type==='ratio')return n.toFixed(2);return `${type==='money'?'¥ ':''}${new Intl.NumberFormat('zh-CN',{maximumFractionDigits:type==='money'?2:0}).format(n)}${['单','件'].includes(type)?` ${type}`:''}`;}
async function load(poll=false){const token=++generation,scope=currentApiCacheScope();if(!poll){attempt=0;loading.value=true;}clearTimeout(timer);error.value='';try{const r=await apiClient.get(`/api/dashboard?view=mobile&date=${shanghaiDateKey()}${poll?'&snapshotOnly=1':''}`,{noCache:true});if(disposed||token!==generation||scope!==currentApiCacheScope())return;
 data.value={...r,metrics:{...data.value.metrics,...r.metrics}};
 if(r.snapshot?.status==='building'&&attempt++<60)timer=window.setTimeout(()=>load(true),2500);
 }catch(e){if(token===generation&&scope===currentApiCacheScope())error.value=e.message;}finally{if(token===generation)loading.value=false;}}
async function loadFinance(){if(!hasPermission(auth.user,'finance'))return;const token=++financeGeneration,scope=currentApiCacheScope();financeError.value='';try{const r=await apiClient.get(`/api/dashboard?view=mobile-finance&date=${shanghaiDateKey()}`,{noCache:true});if(!disposed&&token===financeGeneration&&scope===currentApiCacheScope())financeMetrics.value=r;}catch(e){if(token===financeGeneration&&scope===currentApiCacheScope())financeError.value=e.message;}}
function refresh(){load();loadFinance();}
function resetScope(){++financeGeneration;financeMetrics.value={};financeError.value='';++generation;clearTimeout(timer);data.value={metrics:{}};error.value='';}
onMounted(()=>{refresh();window.addEventListener('erp:auth-scope-changed',resetScope);});onBeforeUnmount(()=>{disposed=true;resetScope();window.removeEventListener('erp:auth-scope-changed',resetScope);});
</script>
<template><div class="mobile-home-page">
 <div class="mobile-home-heading"><div><h1>经营概览</h1><small>{{data.date_key||shanghaiDateKey()}} · 北京时间 · 金额人民币</small></div><el-button :loading="loading" @click="refresh()">刷新</el-button></div>
 <el-alert v-if="financeError" :title="'采购和库存金额读取失败，可刷新重试：'+financeError" type="warning" :closable="false"/>
 <el-alert v-if="error" :title="error" type="warning" :closable="false"/>
 <p v-if="data.snapshot?.status==='building'" class="mobile-status">指标正在更新，已返回的数据先展示。</p>
 <section class="mobile-metric-grid"><article v-for="[key,label,type] in fields" :key="key" :class="{'is-key':key==='today_profit'||key==='today_revenue'}" :data-metric="key"><template v-if="key==='inventory_total_value'&&canAccessPage(auth.user,'/mobile/inventory-capital')"><button class="inventory-metric-link" @click="router.push('/mobile/inventory-capital')"><small>{{label}} · 查看明细 →</small><strong :title="display(key,type)">{{display(key,type)}}</strong></button></template><template v-else><small>{{label}}</small><strong :title="display(key,type)">{{display(key,type)}}</strong></template></article></section>

</div></template>
<style scoped>
.inventory-metric-link{display:grid;gap:9px;text-align:left;border:0;background:none;padding:0;color:inherit;font:inherit;cursor:pointer;min-width:0}
.mobile-home-page{display:grid;gap:12px}.mobile-home-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.mobile-home-heading h1{margin:0 0 5px;font-size:20px}.mobile-home-heading small,.mobile-status{color:var(--el-text-color-secondary);font-size:11px;line-height:1.5}.mobile-metric-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.mobile-metric-grid article{min-width:0;display:flex;flex-direction:column;justify-content:space-between;gap:10px;padding:13px 12px;border:1px solid var(--el-border-color-light);border-radius:12px;background:var(--el-bg-color);min-height:76px;box-sizing:border-box}.mobile-metric-grid article.is-key{background:var(--el-color-primary-light-9);border-color:var(--el-color-primary-light-7)}.mobile-metric-grid small{font-size:12px;color:var(--el-text-color-regular)}.mobile-metric-grid strong{font-size:clamp(17px,4.6vw,23px);line-height:1.2;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--el-text-color-primary)}.mobile-metric-grid .is-key strong{color:var(--el-color-primary)}@media(min-width:700px){.mobile-metric-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
</style>

<script setup>
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useAuthStore} from '../../stores/auth.js';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {canAccessPage} from '../../../../src/shared/permissions.js';
import {shanghaiDateKey} from '../../utils/shanghai-date.js';
import {mobileAnnualTotals,mobileMoney,mobileRatio,mobileMonthQuery} from '../../utils/mobile-finance-period.js';
import '../../styles/mobile-finance.css';

const route=useRoute(),router=useRouter(),auth=useAuthStore(),today=shanghaiDateKey();
const years=Array.from({length:Number(today.slice(0,4))-2019},(_,index)=>String(Number(today.slice(0,4))-index));
const year=ref(today.slice(0,4)),companyId=ref('all'),shopId=ref('all');
const months=ref([]),companies=ref([]),shops=ref([]),loading=ref(false),loaded=ref(false),error=ref('');
const allowed=computed(()=>canAccessPage(auth.user,'/mobile/finance'));
let generation=0,controller,disposed=false,navigation=0,navigatingKey='';
const calendar=computed(()=>Array.from({length:12},(_,index)=>{const key=`${year.value}-${String(index+1).padStart(2,'0')}`;return {key,label:`${index+1}月`,future:key>today.slice(0,7),summary:months.value.find(row=>row.month_key===key)?.summary};}));
const totals=computed(()=>mobileAnnualTotals(months.value,calendar.value.filter(row=>!row.future).map(row=>row.key)));
function routeFilters(){year.value=years.includes(String(route.query.year))?String(route.query.year):today.slice(0,4);companyId.value=String(route.query.companyId||'all');shopId.value=String(route.query.shopId||'all');}
const filterKey=query=>JSON.stringify([String(query.year||today.slice(0,4)),String(query.companyId||'all'),String(query.shopId||'all')]);
async function changeFilters(companyChanged=false){if(companyChanged)shopId.value='all';const query={year:year.value,companyId:companyId.value,shopId:shopId.value},same=filterKey(route.query)===filterKey(query),turn=++navigation;navigatingKey=filterKey(query);++generation;controller?.abort();months.value=[];loaded.value=false;loading.value=true;error.value='';await router.replace({query});if(disposed||turn!==navigation)return;navigatingKey='';if(same)load();}
function clearScope(){++generation;controller?.abort();months.value=[];companies.value=[];shops.value=[];loaded.value=false;loading.value=false;error.value='';}
async function load(){
  const scope=currentApiCacheScope(),token=++generation;controller?.abort();controller=new AbortController();months.value=[];loaded.value=false;error.value='';
  if(!allowed.value){loading.value=false;return;}loading.value=true;
  const params=new URLSearchParams({year:year.value,fromMonth:'1',toMonth:year.value===today.slice(0,4)?String(Number(today.slice(5,7))):'12',companyId:companyId.value,shopId:shopId.value,overviewOnly:'1'});
  try{const response=await apiClient.get(`/api/monthly-billing-details?${params}`,{noCache:true,signal:controller.signal});
    if(disposed||token!==generation||scope!==currentApiCacheScope()||!allowed.value)return;
    months.value=Array.isArray(response.months)?response.months:[];companies.value=Array.isArray(response.companies)?response.companies:[];shops.value=Array.isArray(response.shops)?response.shops:[];loaded.value=true;
  }catch(e){if(e.name!=='AbortError'&&token===generation&&scope===currentApiCacheScope())error.value=e.message||'经营总览读取失败';}
  finally{if(token===generation)loading.value=false;}
}
function bill(month){if(month.future||loading.value)return;router.push({path:'/mobile/monthly-billing',query:mobileMonthQuery(month.key,today,{companyId:companyId.value,shopId:shopId.value,overviewYear:year.value})});}
watch(()=>[route.query.year,route.query.companyId,route.query.shopId,auth.user?.personId,auth.user?.tenant?.id,allowed.value],()=>{if(navigatingKey&&filterKey(route.query)!==navigatingKey)return;routeFilters();load();},{immediate:true});
onMounted(()=>{document.querySelector('.mobile-content')?.scrollTo(0,0);window.addEventListener('erp:auth-scope-changed',clearScope);});
onBeforeUnmount(()=>{disposed=true;clearScope();window.removeEventListener('erp:auth-scope-changed',clearScope);});
</script>

<template>
  <div class="mobile-finance-page">
    <div class="mobile-finance-heading"><div><h1>经营总览</h1><p>按年看整体经营，按月进入账单</p></div><el-button :loading="loading" @click="load">刷新</el-button></div>
    <el-alert v-if="!allowed" title="当前岗位无经营账单查看权限" type="warning" :closable="false"/>
    <template v-else>
      <div class="mobile-finance-filters">
        <label>年份<select v-model="year" aria-label="经营年份" @change="changeFilters()"><option v-for="value in years" :key="value" :value="value">{{value}}年</option></select></label>
        <label>公司<select v-model="companyId" aria-label="经营公司" @change="changeFilters(true)"><option value="all">全部公司</option><option v-if="companyId!=='all'&&!companies.some(row=>String(row.id)===companyId)" :value="companyId">当前公司筛选</option><option v-for="company in companies" :key="company.id" :value="String(company.id)">{{company.name}}</option></select></label>
        <label>店铺<select v-model="shopId" aria-label="经营店铺" @change="changeFilters()"><option value="all">全部店铺</option><option v-if="shopId!=='all'&&!shops.some(row=>String(row.id)===shopId)" :value="shopId">当前店铺筛选</option><option v-for="shop in shops" :key="shop.id" :value="String(shop.id)">{{shop.name}}</option></select></label>
      </div>
      <p class="mobile-finance-note">{{year}}年{{year===today.slice(0,4)?`截至 ${today}`:'全年'}} · 北京时间 · 人民币</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false"/>
      <section class="mobile-finance-metrics" aria-label="年度经营指标">
        <article data-metric="revenue"><span>累计收入</span><strong>{{loaded?mobileMoney(totals.revenue):'—'}}</strong></article>
        <article data-metric="net_profit"><span>累计经营净利润</span><strong :class="{negative:Number(totals.net_profit)<0}">{{loaded?mobileMoney(totals.net_profit):'—'}}</strong></article>
        <article data-metric="margin"><span>净利润率</span><strong>{{loaded?mobileRatio(totals.margin):'—'}}</strong></article>
        <article data-metric="expenses"><span>费用与人工</span><strong>{{loaded?mobileMoney(totals.expenses):'—'}}</strong></article>
      </section>
      <h2>各月经营账单</h2>
      <section class="mobile-month-list" aria-label="月份账单">
        <button v-for="month in calendar" :key="month.key" type="button" class="mobile-month-card" :disabled="month.future||loading" :data-month="month.key" @click="bill(month)">
          <div class="mobile-finance-row"><strong>{{month.label}}</strong><small>{{month.future?'尚未开始':month.key===today.slice(0,7)?'进行中':'历史月份'}} <span v-if="!month.future" aria-hidden="true">→</span></small></div>
          <div class="mobile-month-values"><span>收入<b>{{month.future||!loaded?'—':mobileMoney(month.summary?.revenue)}}</b></span><span>经营净利润<b :class="{negative:Number(month.summary?.net_profit)<0}">{{month.future||!loaded?'—':mobileMoney(month.summary?.net_profit)}}</b></span></div>
          <small v-if="!month.future&&loaded&&!month.summary">本月汇总未返回，点击查看账单</small>
        </button>
      </section>
      <p class="mobile-finance-note">经营净利润沿用月度账单口径，包含费用与人工；与首页订单利润不同。库存占用是当前资产，不重复计入经营成本。店铺筛选不含公司共用费用。</p>
    </template>
  </div>
</template>

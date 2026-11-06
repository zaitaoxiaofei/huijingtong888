<script setup>
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {useAuthStore} from '../../stores/auth.js';
import {apiClient,currentApiCacheScope} from '../../utils/api.js';
import {canAccessPage} from '../../../../src/shared/permissions.js';
import {shanghaiDateKey,shanghaiDateText} from '../../utils/shanghai-date.js';
import {validMobileMonth,mobileMonthRange,mobileMonthQuery,mobileMoney,mobileInteger,mobileRatio} from '../../utils/mobile-finance-period.js';
import '../../styles/mobile-finance.css';

const route=useRoute(),router=useRouter(),auth=useAuthStore(),today=shanghaiDateKey();
const month=ref(today.slice(0,7)),companyId=ref('all'),shopId=ref('all'),overviewYear=ref(today.slice(0,4));
const bill=ref(null),companies=ref([]),shops=ref([]),loading=ref(false),error=ref(''),metaError=ref('');
const allowed=computed(()=>canAccessPage(auth.user,'/mobile/monthly-billing'));
const range=computed(()=>mobileMonthRange(month.value,today)),summary=computed(()=>bill.value?.summary||{});
const costs=[['purchase_cost','采购成本'],['domestic_shipping_cost','国内物流'],['international_shipping_cost','国际物流'],['packaging_cost','包装处理'],['commission_fee','Ozon佣金'],['ozon_service_fee','Ozon服务费'],['other_fee','其他费用'],['advertising_cost','广告费用'],['return_loss','退货损失'],['manual_expense','人工账单'],['salary_expense','工资']];
const expenseTitle=expense=>String(expense.description||'').trim()||({office:'办公',salary:'工资',rent:'房租',software:'软件',travel:'差旅',bank:'银行手续费',domestic_logistics:'国内物流',other:'其他费用'}[expense.category]||'其他费用');
let generation=0,controller,disposed=false,navigation=0,navigatingKey='';
function routeFilters(){month.value=validMobileMonth(route.query.month,today)?String(route.query.month):today.slice(0,7);companyId.value=String(route.query.companyId||'all');shopId.value=String(route.query.shopId||'all');overviewYear.value=/^\d{4}$/.test(String(route.query.overviewYear||''))?String(route.query.overviewYear):month.value.slice(0,4);}
const filterKey=query=>JSON.stringify([String(query.month||today.slice(0,7)),String(query.companyId||'all'),String(query.shopId||'all'),String(query.overviewYear||String(query.month||today.slice(0,7)).slice(0,4))]);
async function changeFilters(companyChanged=false){if(!validMobileMonth(month.value,today)){month.value=validMobileMonth(route.query.month,today)?String(route.query.month):today.slice(0,7);error.value='请选择本月或更早的有效月份';return;}if(companyChanged)shopId.value='all';const query=mobileMonthQuery(month.value,today,{companyId:companyId.value,shopId:shopId.value,overviewYear:overviewYear.value}),same=filterKey(route.query)===filterKey(query),turn=++navigation;navigatingKey=filterKey(query);++generation;controller?.abort();bill.value=null;loading.value=true;error.value='';metaError.value='';await router.replace({query});if(disposed||turn!==navigation)return;navigatingKey='';if(same)load();}
function back(){router.push({path:'/mobile/finance',query:{year:overviewYear.value,companyId:companyId.value,shopId:shopId.value}});}
function clearScope(){++generation;controller?.abort();bill.value=null;companies.value=[];shops.value=[];loading.value=false;error.value='';metaError.value='';}
async function load(){
  const scope=currentApiCacheScope(),token=++generation;controller?.abort();controller=new AbortController();bill.value=null;error.value='';metaError.value='';
  if(!allowed.value){loading.value=false;return;}loading.value=true;
  const params=new URLSearchParams({year:month.value.slice(0,4),month:month.value.slice(5,7),from:range.value[0],to:range.value[1],companyId:companyId.value,shopId:shopId.value,includeAppendices:'0'});
  const isCurrent=()=>!disposed&&token===generation&&scope===currentApiCacheScope()&&allowed.value;
  try{const details=apiClient.get(`/api/monthly-billing-details?${params}`,{noCache:true,signal:controller.signal});
    apiClient.get('/api/finance-center/companies',{signal:controller.signal}).then(meta=>{if(isCurrent())companies.value=Array.isArray(meta.companies)?meta.companies:[];}).catch(e=>{if(e.name!=='AbortError'&&isCurrent())metaError.value='公司筛选读取失败，已保留当前筛选';});
    const response=await details;if(!isCurrent())return;
    const selected=response.selected||response.months?.find(row=>row.month_key===month.value);
    if(!selected?.summary)throw Error('所选月份账单未返回，请刷新重试');
    bill.value=selected;shops.value=Array.isArray(response.shops)?response.shops:[];
  }catch(e){if(e.name!=='AbortError'&&isCurrent())error.value=e.message||'月度账单读取失败';}
  finally{if(token===generation)loading.value=false;}
}
watch(()=>[route.query.month,route.query.companyId,route.query.shopId,route.query.overviewYear,auth.user?.personId,auth.user?.tenant?.id,allowed.value],()=>{if(navigatingKey&&filterKey(route.query)!==navigatingKey)return;routeFilters();load();},{immediate:true});
onMounted(()=>{document.querySelector('.mobile-content')?.scrollTo(0,0);window.addEventListener('erp:auth-scope-changed',clearScope);});
onBeforeUnmount(()=>{disposed=true;clearScope();window.removeEventListener('erp:auth-scope-changed',clearScope);});
</script>

<template>
  <div class="mobile-finance-page">
    <div class="mobile-finance-heading"><div><h1>月度账单</h1><button type="button" class="mobile-finance-back" @click="back">← 返回经营总览</button></div><el-button :loading="loading" @click="load">刷新</el-button></div>
    <el-alert v-if="!allowed" title="当前岗位无月度账单查看权限" type="warning" :closable="false"/>
    <template v-else>
      <div class="mobile-finance-filters">
        <label>账单月份<input v-model="month" type="month" min="2020-01" :max="today.slice(0,7)" aria-label="账单月份" @change="changeFilters()"/></label>
        <label>公司<select v-model="companyId" aria-label="账单公司" @change="changeFilters(true)"><option value="all">全部公司</option><option v-if="companyId!=='all'&&!companies.some(row=>String(row.id)===companyId)" :value="companyId">当前公司筛选</option><option v-for="company in companies" :key="company.id" :value="String(company.id)">{{company.name}}</option></select></label>
        <label>店铺<select v-model="shopId" aria-label="账单店铺" @change="changeFilters()"><option value="all">全部店铺</option><option v-if="shopId!=='all'&&!shops.some(row=>String(row.id)===shopId)" :value="shopId">当前店铺筛选</option><option v-for="shop in shops" :key="shop.id" :value="String(shop.id)">{{shop.name}}</option></select></label>
      </div>
      <p class="mobile-finance-note">{{range[0]}} 至 {{range[1]}} · 北京时间 · 人民币{{month===today.slice(0,7)?' · 本月累计':''}}</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false"/>
      <el-alert v-if="metaError" :title="metaError" type="warning" :closable="false"/>
      <section class="mobile-finance-metrics" aria-label="月度经营指标">
        <article data-metric="revenue"><span>收入</span><strong>{{mobileMoney(summary.revenue)}}</strong></article>
        <article data-metric="net_profit"><span>经营净利润</span><strong :class="{negative:Number(summary.net_profit)<0}">{{mobileMoney(summary.net_profit)}}</strong></article>
        <article><span>有效订单</span><strong>{{mobileInteger(summary.order_count)}}<small> 单</small></strong></article>
        <article><span>净利润率</span><strong>{{mobileRatio(summary.net_profit_margin)}}</strong></article>
      </section>
      <section class="mobile-finance-section"><h2>利润与结算</h2><dl><div><dt>订单利润（未扣广告与人工）</dt><dd>{{mobileMoney(summary.profit)}}</dd></div><div><dt>已结算利润 · {{mobileInteger(summary.accrued_order_count)}} 单</dt><dd>{{mobileMoney(summary.accrued_profit)}}</dd></div><div><dt>待结算利润 · {{mobileInteger(summary.pending_order_count)}} 单</dt><dd>{{mobileMoney(summary.pending_profit)}}</dd></div></dl></section>
      <section class="mobile-finance-section"><h2>费用明细</h2><dl><div v-for="[key,label] in costs" :key="key"><dt>{{label}}</dt><dd>{{mobileMoney(summary[key])}}</dd></div></dl><p class="mobile-finance-note">经营净利润沿用原账单口径，不把当前库存资产重复计入本月成本。</p></section>
      <section class="mobile-finance-section"><h2>店铺明细</h2><p v-if="!bill" class="mobile-finance-note">{{loading?'正在读取账单…':'账单尚未读取'}}</p><p v-else-if="!bill.shops?.length" class="mobile-finance-note">本月没有店铺明细，费用仍按账单显示。</p><article v-for="shop in bill?.shops||[]" :key="shop.shop_id" class="mobile-finance-detail"><strong>{{shop.shop_name||shop.name||'店铺'}}</strong><div class="mobile-month-values"><span>收入<b>{{mobileMoney(shop.revenue)}}</b></span><span>经营净利润<b>{{mobileMoney(shop.net_profit)}}</b></span></div></article></section>
      <section class="mobile-finance-section"><h2>人工与其他费用记录</h2><p v-if="!bill" class="mobile-finance-note">账单尚未读取</p><p v-else-if="!bill.expenses?.length" class="mobile-finance-note">本月无人工与其他费用记录，工资另见费用明细。</p><article v-for="expense in bill?.expenses||[]" :key="expense.id" class="mobile-finance-detail"><div class="mobile-finance-row"><strong>{{expenseTitle(expense)}}</strong><b>{{mobileMoney(expense.amount_cny)}}</b></div><small>{{shanghaiDateText(expense.expense_date)}} · {{expense.shop_name||'公司共用'}}</small></article></section>
    </template>
  </div>
</template>

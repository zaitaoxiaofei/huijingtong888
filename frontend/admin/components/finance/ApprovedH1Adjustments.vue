<script setup>
import {onBeforeUnmount,ref,watch} from 'vue';
import {apiClient,currentApiCacheScope} from '../../utils/api';
import FinanceAdjustmentDetail from './FinanceAdjustmentDetail.vue';
const props=defineProps({companyId:{required:true},from:{required:true},to:{required:true},shops:{type:Array,default:()=>[]}});
const data=ref(null),error=ref(''),loading=ref(false),page=ref(1),shop=ref(''),keyword=ref(''),detail=ref(null);
const money=n=>n==null?'—':Number(n).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
let generation=0,controller;
async function load(){const token=++generation,scope=currentApiCacheScope();controller?.abort();controller=new AbortController();loading.value=true;error.value='';data.value=null;detail.value=null;
 try{const query=new URLSearchParams({company_id:props.companyId,from:props.from,to:props.to,page:page.value,shop_id:shop.value,keyword:keyword.value});const result=await apiClient.get('/api/finance-center/document-adjustments?'+query,{noCache:true,signal:controller.signal});if(token===generation&&scope===currentApiCacheScope())data.value=result;}
 catch(e){if(token===generation&&e.name!=='AbortError')error.value=e.message;}finally{if(token===generation)loading.value=false;}}
watch(()=>[props.companyId,props.from,props.to,currentApiCacheScope()],()=>{page.value=1;shop.value='';keyword.value='';load();},{immediate:true});
watch(shop,()=>{page.value=1;load();});
onBeforeUnmount(()=>{generation++;controller?.abort();});
</script>
<template>
 <section v-loading="loading">
  <div class="adjustment-toolbar"><el-select v-model="shop" aria-label="调整店铺" clearable placeholder="全部店铺"><el-option v-for="s in shops" :key="s.id" :value="String(s.id)" :label="s.name"/></el-select><el-input v-model="keyword" aria-label="搜索调整记录" placeholder="货件号 / SKU / 调整编号" clearable @keyup.enter="page=1;load()" @clear="page=1;load()"/><el-button @click="page=1;load()">查询</el-button><el-button @click="load">刷新</el-button></div>
  <el-alert v-if="error" :title="error" type="error" :closable="false"/>
  <template v-if="data">
   <p>2026年一、二季度已应用 {{data.summary.applied}} 项 · 收入变化 {{money(data.summary.revenue_delta)}} 元 · 佣金变化 {{money(data.summary.commission_delta)}} 元<span v-if="data.summary.stale"> · {{data.summary.stale}} 项待重新核对</span></p>
   <p>调整后金额用于ERP月度账单；官方文件汇总不重复加计调整额。其他费用仍待核对。</p>
   <el-table :data="data.rows" border>
    <el-table-column label="店铺 / 月份" min-width="175"><template #default="{row}">{{shops.find(s=>Number(s.id)===row.shop_id)?.name||'店铺 #'+row.shop_id}}<small>{{row.month}}</small></template></el-table-column>
    <el-table-column label="货件 / SKU" min-width="205"><template #default="{row}">{{row.posting_number}}<small>{{row.sku}}</small></template></el-table-column>
    <el-table-column label="原收入 CNY" align="center" min-width="135"><template #default="{row}">{{money(row.before?.revenue)}}</template></el-table-column>
    <el-table-column label="调整收入 CNY" align="center" min-width="135"><template #default="{row}">{{money(row.after.net_revenue)}}</template></el-table-column>
    <el-table-column label="原佣金 CNY" align="center" min-width="135"><template #default="{row}">{{money(row.before?.commission)}}</template></el-table-column>
    <el-table-column label="调整佣金 CNY" align="center" min-width="135"><template #default="{row}">{{money(row.after.commission_fee)}}</template></el-table-column>
    <el-table-column label="状态" min-width="120"><template #default="{row}">{{row.status==='applied'?'已应用 · 待核对':row.status==='superseded'?'已被后续调整替代':'未应用 · 原账变化'}}</template></el-table-column>
    <el-table-column label="" width="155"><template #default="{row}"><el-button link type="primary" @click="detail=row">原账与调整依据</el-button></template></el-table-column>
   </el-table>
   <el-pagination v-model:current-page="page" :page-size="50" :total="data.total" layout="total, prev, pager, next" @current-change="load"/>
  </template>
  <el-dialog :model-value="!!detail" title="原账与调整依据" width="min(96vw,1000px)" destroy-on-close @close="detail=null"><FinanceAdjustmentDetail v-if="detail" :records="[detail]"/></el-dialog>
 </section>
</template>
<style scoped>
.adjustment-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}.adjustment-toolbar .el-select{width:230px}.adjustment-toolbar .el-input{width:280px}small{display:block;color:var(--el-text-color-secondary)}p{color:var(--el-text-color-secondary);font-size:13px}.el-pagination{margin-top:14px}
</style>

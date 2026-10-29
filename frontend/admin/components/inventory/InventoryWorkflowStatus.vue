<script setup>
import { computed } from 'vue';
const props=defineProps({state:Object,orderCovered:{default:null}});
const type=computed(()=>({danger:'danger',warning:'warning',opportunity:'primary',success:'success'})[props.state?.overall]||'info');
const labels={real_order:'FBS供货不足',local_safety:'本地保障不足',fbp_stock:'FBP供货不足'};
const text=computed(()=>{
 if(!props.state)return '需求核对中';
 if(props.state.overall==='danger')return labels[props.state.demands?.find(d=>d.status==='danger')?.key]||'供货不足';
 return{warning:'可能不足／申请待处理',success:'供货充足',opportunity:'FBP备货机会',unknown:'需求待核对'}[props.state.overall]||'需求待核对';
});
const hint=computed(()=>props.state?.demands?.map(d=>`${d.label}：建议采购 ${d.purchase_quantity??'待核对'} 件`).join('；')||'独立读取商品整体供货需求，不阻塞当前列表；未知数量不按零计算');
</script>
<template><el-tooltip :content="hint" placement="top"><el-tag :type="type" size="small" effect="plain"><template v-if="orderCovered===true">本单已覆盖 · </template>{{text}}</el-tag></el-tooltip></template>

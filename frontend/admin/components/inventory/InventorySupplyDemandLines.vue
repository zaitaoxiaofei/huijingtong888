<script setup>
import {computed} from 'vue';
import {inventorySupplyLines,inventorySupplyLineFacts} from '../../../../src/shared/inventory-supply-lines.js';
const props=defineProps({workflow:Object,group:{type:String,default:'all'},canSync:Boolean,syncing:Boolean,syncError:String});
const emit=defineEmits(['detail','sync']);
const lines=computed(()=>inventorySupplyLines(props.workflow).filter(line=>props.group==='all'||(props.group==='local'?['orders','safety']:['fbp','forecast']).includes(line.key)).map(line=>({...line,facts:inventorySupplyLineFacts(line)})));
const quantity=n=>n==null?'待核对':`${Number(n)} 件`;
function targetText(line){
 const target=line.facts[0];
 if(target.value==null){if(line.key==='forecast')return props.workflow?.fbp?.sku_count===0?'未绑定SKU':'待同步';return `${target.label}待核对`;}
 return `${target.label} ${quantity(target.value)}`;
}
</script>
<template>
 <div class="compact-demand-lines">
  <div v-for="line in lines" :key="line.key" :class="['compact-demand-line',`is-${line.status}`]">
   <div class="compact-demand-heading">
    <el-button plain size="small" @click="emit('detail',line.key)">{{line.label}}</el-button>
    <el-popover trigger="hover" placement="top" :width="350">
     <template #reference><span class="compact-demand-target">{{targetText(line)}}</span></template>
     <p v-for="fact in line.facts" :key="fact.label">{{fact.label}}：{{quantity(fact.value)}}</p>
     <p v-if="line.key==='orders'">订单需求是实际库存件数，不是订单笔数；现货和在途已分配后，剩余部分才需要采购。</p>
     <p v-if="line.key==='safety'">保障目标是按消耗和备货周期计算的安全库存，不是新增订单，补货可选。</p>
     <p v-if="line.key==='fbp'">申请数量包含待审核和已审批待发的实物需求。FBS先分配现货，再分配FBP正式申请；审核预留不等于已发运，确认发货后才实际出库。</p>
     <p v-if="line.partial">当前仅确认订单采购缺口；现货分配仍待核实，账面差异不重复增加采购量。</p>
     <p v-if="line.key==='forecast'&&!workflow?.fbp?.known">{{workflow?.fbp?.unknown_reason||'官方库存尚未完整同步'}}</p>
     <p>点击需求名称查看订单、规则或申请明细。</p>
    </el-popover>
    <el-button v-if="line.key==='forecast'&&!(line.purchase>0)&&canSync" plain size="small" :loading="syncing" @click="emit('sync')">{{syncing?'同步中':'同步重算'}}</el-button>
   </div>
   <div class="compact-demand-breakdown">
    <span v-for="fact in line.facts.slice(1)" :key="fact.label" :class="['compact-demand-fact',{'is-required':fact.kind==='purchase'&&line.required&&fact.value>0,'is-optional':fact.kind==='purchase'&&!line.required&&fact.value>0,'is-locked':fact.kind==='locked'}]">{{fact.label}} <b>{{quantity(fact.value)}}</b></span>
   </div>
  </div>
  <el-tooltip v-if="syncError&&group!=='local'" :content="syncError"><el-button plain size="small" type="danger" @click="emit('sync')">同步未完成，点击重试</el-button></el-tooltip>
 </div>
</template>
<style scoped>
.compact-demand-lines{display:grid;gap:10px;font-size:12px}.compact-demand-line{display:grid;gap:4px;min-width:0}.compact-demand-heading{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-height:28px}.compact-demand-heading>.el-button{margin:0;font-size:12px}.compact-demand-target{font-variant-numeric:tabular-nums;cursor:help;white-space:nowrap;color:var(--el-text-color-primary)}.compact-demand-breakdown{display:flex;flex-wrap:wrap;gap:3px 10px;color:var(--el-text-color-secondary);line-height:1.5}.compact-demand-fact{white-space:nowrap;font-variant-numeric:tabular-nums}.compact-demand-fact b{font-weight:500}.is-required{color:var(--el-color-danger)}.is-optional{color:var(--el-color-warning)}.is-locked{color:var(--el-text-color-primary)}
</style>

<script setup>
import {computed} from 'vue';
import {inventorySupplyLines} from '../../../../src/shared/inventory-supply-lines.js';
const props=defineProps({workflow:Object,canSync:Boolean,syncing:Boolean,syncError:String});
const emit=defineEmits(['detail','sync']);
const lines=computed(()=>inventorySupplyLines(props.workflow));
const quantity=n=>n==null?'待核对':`${Number(n)} 件`;
function summary(line){
 if(line.quantity==null)return line.key==='forecast'?'待同步':'待核实';
 if(line.key==='fbp'&&line.quantity===0)return '暂无申请';
 if(line.quantity===0)return '已覆盖';
 return `${line.partial?'未覆盖 ':''}${quantity(line.quantity)}`;
}
</script>
<template>
 <div class="compact-demand-lines">
  <div v-for="line in lines" :key="line.key" :class="['compact-demand-line',`is-${line.status}`]">
   <el-button link :type="line.status" @click="emit('detail',line.key)">{{line.label}}</el-button>
   <el-popover trigger="hover" placement="top" :width="330">
    <template #reference><span class="compact-demand-quantity">{{summary(line)}}</span></template>
    <p>{{line.label}}：{{quantity(line.target??line.quantity)}}</p>
    <p v-if="line.partial">按当前未覆盖订单采购；账面差异另行核对，不重复增加采购量。</p>
    <p v-if="line.incoming!=null">采购在途覆盖 {{quantity(line.incoming)}}</p>
    <p v-if="line.stock!=null">本地现货覆盖 {{quantity(line.stock)}}</p>
    <p v-if="line.purchase!=null">{{line.required?'必须采购':'建议采购'}} {{quantity(line.purchase)}}</p>
    <p v-if="line.key==='forecast'&&!workflow?.fbp?.known">{{workflow?.fbp?.unknown_reason||'官方库存尚未完整同步'}}</p>
    <p>点击需求名称查看订单、规则或申请明细。</p>
   </el-popover>
   <span v-if="line.purchase>0" :class="['compact-demand-buy',line.required?'required':'optional']">{{line.required?'采购':'建议'}} {{line.purchase}}</span>
   <el-button v-else-if="line.key==='forecast'&&canSync" link type="primary" :loading="syncing" @click="emit('sync')">{{syncing?'同步中':'同步重算'}}</el-button>
  </div>
  <el-tooltip v-if="syncError" :content="syncError"><el-button link type="danger" @click="emit('sync')">同步未完成，点击重试</el-button></el-tooltip>
 </div>
</template>
<style scoped>
.compact-demand-lines{display:grid;gap:3px;font-size:12px}.compact-demand-line{display:grid;grid-template-columns:minmax(92px,1fr) auto minmax(70px,auto);align-items:center;gap:9px;min-height:24px;padding:1px 0;border-bottom:1px solid var(--el-border-color-extra-light)}.compact-demand-line>.el-button{justify-self:start;margin:0;padding:1px 0;font-size:12px}.compact-demand-quantity{font-variant-numeric:tabular-nums;cursor:help;white-space:nowrap}.compact-demand-buy{text-align:right;font-size:12px;white-space:nowrap}.required,.is-danger .compact-demand-quantity{color:var(--el-color-danger)}.optional,.is-warning .compact-demand-quantity{color:var(--el-color-warning)}.is-success .compact-demand-quantity{color:var(--el-color-success)}
</style>

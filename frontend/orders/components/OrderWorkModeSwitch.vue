<script setup>
import {computed} from 'vue';
import {ArrowDown} from '@element-plus/icons-vue';
const props=defineProps({mode:{type:String,default:'print'}}),emit=defineEmits(['change']);
const label=computed(()=>props.mode==='inventory'?'库存管理模式':'打印模式');
</script>
<template>
 <el-dropdown trigger="click" @command="value=>emit('change',value)">
  <el-button class="order-work-mode-switch" :aria-label="`当前${label}，切换模式`"><span class="mode-current">{{label}}</span><span class="mode-switch">切换模式</span><el-icon><ArrowDown/></el-icon></el-button>
  <template #dropdown><el-dropdown-menu class="order-work-mode-menu">
   <el-dropdown-item command="print" :disabled="mode==='print'"><div><b>打印模式</b><small>处理订单打印、打包和发货</small></div></el-dropdown-item>
   <el-dropdown-item command="inventory" :disabled="mode==='inventory'"><div><b>库存管理模式</b><small>检查库存缺口、采购进度、到货验收与实物核对</small></div></el-dropdown-item>
  </el-dropdown-menu></template>
 </el-dropdown>
</template>
<style scoped>
.order-work-mode-switch{min-width:130px;gap:8px}.mode-switch{display:none}.order-work-mode-switch:hover .mode-current,.order-work-mode-switch:focus-visible .mode-current{display:none}.order-work-mode-switch:hover .mode-switch,.order-work-mode-switch:focus-visible .mode-switch{display:inline}.order-work-mode-menu div{display:grid;gap:5px;padding:6px 0}.order-work-mode-menu small{color:var(--el-text-color-secondary);font-size:12px;white-space:normal;max-width:300px}
</style>

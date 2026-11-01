<script setup>
import {computed} from 'vue';
const props=defineProps({mode:{type:String,default:'print'}}),emit=defineEmits(['change']);
const label=computed(()=>props.mode==='inventory'?'库存管理模式':'打印模式');
</script>
<template>
 <el-tooltip :content="mode==='inventory'?'切换到打印模式：处理订单打印、打包和发货':'切换到库存管理模式：检查库存缺口、采购进度、到货验收与实物核对'" placement="bottom-end">
  <el-button class="order-work-mode-switch" :aria-label="`当前${label}，切换模式`" @click="emit('change',mode==='inventory'?'print':'inventory')"><span class="mode-current">{{label}}</span><span class="mode-switch">切换模式</span></el-button>
 </el-tooltip>
</template>
<style scoped>
.order-work-mode-switch{min-width:130px;gap:8px}.mode-switch{display:none}.order-work-mode-switch:hover .mode-current,.order-work-mode-switch:focus-visible .mode-current{display:none}.order-work-mode-switch:hover .mode-switch,.order-work-mode-switch:focus-visible .mode-switch{display:inline}
</style>

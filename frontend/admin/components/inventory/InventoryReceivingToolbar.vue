<script setup>
import InventoryPageToolbar from './InventoryPageToolbar.vue';
defineProps({filters:{type:Object,required:true},loading:Boolean});
defineEmits(['search','reset']);
</script>
<template>
  <InventoryPageToolbar product-search :filters="filters" :loading="loading" :show-shop="false" :show-date-range="false" @search="$emit('search')" @reset="$emit('reset')">
    <el-form-item label="库存类型"><el-select v-model="filters.inventoryType"><el-option label="全部库存" value="all"/><el-option label="单品" value="single"/><el-option label="配件" value="accessory"/><el-option label="套装" value="combo"/></el-select></el-form-item>
    <el-form-item label="需求类型"><el-select v-model="filters.demandType"><el-option label="全部需求" value="all"/><el-option label="FBS真实订单" value="real_order"/><el-option label="本地安全保障" value="local_safety"/><el-option label="FBP备货" value="fbp_stock"/></el-select></el-form-item>
    <template #actions><slot/></template>
  </InventoryPageToolbar>
</template>

<script setup>
import InventoryProductEditAction from './InventoryProductEditAction.vue';
import InventoryProductHistoryAction from './InventoryProductHistoryAction.vue';
defineProps({productId:{type:Number,required:true}});
const emit=defineEmits(['saved']);
</script>
<template>
 <div v-if="Number.isSafeInteger(productId)&&productId>0" class="inventory-product-actions">
  <InventoryProductEditAction :product-id="productId" @saved="value=>emit('saved',value)"/>
  <InventoryProductHistoryAction :product-id="productId"/>
 </div>
</template>
<style scoped>
.inventory-product-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.inventory-product-actions :deep(.el-button+.el-button){margin-left:0}
</style>

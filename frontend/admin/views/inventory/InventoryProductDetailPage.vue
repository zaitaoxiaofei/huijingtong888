<script setup>
import { computed } from 'vue';
import { useRoute,useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth.js';
import { hasPermission } from '../../../../src/shared/permissions.js';
import ProcurementLedgerDialog from '../../components/procurement/ProcurementLedgerDialog.vue';
const route=useRoute(),router=useRouter(),auth=useAuthStore();
const id=computed(()=>Number(route.params.productId));
</script>
<template><ProcurementLedgerDialog v-if="Number.isSafeInteger(id)&&id>0" :key="id" :model-value="true" full-page :product-id="id" :stocktake-enabled="hasPermission(auth.user,'inventory.write')" @update:model-value="value=>!value&&router.push('/inventory/products')" /><el-empty v-else description="库存商品编号无效" /></template>

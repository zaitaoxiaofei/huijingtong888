<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { inventoryModule } from '../constants/inventory-modules.js';
import { useAuthStore } from '../stores/auth.js';
import { canAccessPage } from '../../../src/shared/permissions.js';
const route=useRoute(), router=useRouter(), auth=useAuthStore();
const tabs=computed(()=>inventoryModule(route.path)?.tabs.filter(tab=>canAccessPage(auth.user,tab.path))||[]);
</script>
<template><el-tabs v-if="tabs.length" class="inventory-module-tabs" :model-value="route.path.startsWith('/inventory/products/')?'/inventory/products':route.path" @tab-change="path=>router.push(path)"><el-tab-pane v-for="tab in tabs" :key="tab.path" :name="tab.path" :label="tab.label" /></el-tabs></template>
<style scoped>.inventory-module-tabs { padding:0 16px;flex:0 0 auto; }.inventory-module-tabs :deep(.el-tabs__header){margin:0;}</style>

<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { inventoryModule, inventoryTabKey, inventoryRouteTab } from '../constants/inventory-modules.js';
import { useAuthStore } from '../stores/auth.js';
import { canAccessPage } from '../../../src/shared/permissions.js';
const route=useRoute(), router=useRouter(), auth=useAuthStore();
const tabs=computed(()=>inventoryModule(route.path)?.tabs.filter(tab=>canAccessPage(auth.user,tab.path))||[]);
function navigate(key) {
  const tab=tabs.value.find(tab=>inventoryTabKey(tab)===key);
  if(tab) router.push({path:tab.path,query:tab.status?{status:tab.status}:{}});
}
</script>
<template><el-tabs v-if="tabs.length" class="inventory-module-tabs" :model-value="inventoryRouteTab(route)" @tab-change="navigate"><el-tab-pane v-for="tab in tabs" :key="inventoryTabKey(tab)" :name="inventoryTabKey(tab)" :label="tab.label" /></el-tabs></template>
<style scoped>.inventory-module-tabs { padding:0 16px;flex:0 0 auto; }.inventory-module-tabs :deep(.el-tabs__header){margin:0;}</style>

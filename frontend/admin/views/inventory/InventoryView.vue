<script setup>
import { computed, provide } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fbpRouteStatus } from '../../constants/inventory-modules.js';
const route=useRoute(), router=useRouter();
const replenishmentStatus=computed({
  get:()=>fbpRouteStatus(route.query),
  set:status=>{if(status!==fbpRouteStatus(route.query))router.replace({query:{...route.query,status}});}
});
provide('inventoryFbpReplenishmentStatus',replenishmentStatus);
</script>
<template><div class="page-stack inventory-module-page"><el-card shadow="never" class="page-card inventory-module-card"><router-view /></el-card></div></template>

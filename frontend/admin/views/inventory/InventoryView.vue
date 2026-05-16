<script setup>
import InventorySectionTabs from "../../components/inventory/InventorySectionTabs.vue";
</script>

<template>
  <div class="page-stack inventory-module-page">
    <el-card shadow="never" class="page-card inventory-module-card">
      <InventorySectionTabs />
      <router-view />
    </el-card>
  </div>
</template>

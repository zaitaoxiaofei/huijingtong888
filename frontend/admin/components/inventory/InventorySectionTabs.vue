<script setup>
import { useRoute, useRouter } from "vue-router";
import { inventorySections } from "../../views/inventory/inventory-sections.js";

const route = useRoute();
const router = useRouter();

function openSection(section) {
  router.push(section.route);
}
</script>

<template>
  <div class="inventory-section-tabs">
    <button
      v-for="section in inventorySections"
      :key="section.key"
      type="button"
      class="inventory-section-tab"
      :class="{ active: route.path === section.route }"
      @click="openSection(section)"
    >
      <strong>{{ section.label }}</strong>
    </button>
  </div>
</template>

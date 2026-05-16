<script setup>
defineProps({
  items: { type: Array, default: () => [] }
});
</script>

<template>
  <div v-if="items.length" class="vue-config-summary">
    <span v-for="item in items" :key="`${item.label}-${item.value}`" class="ds-badge" :class="item.tone ? `ds-badge-${item.tone}` : 'ds-badge-info'">
      {{ item.label }} {{ item.value }}
    </span>
  </div>
</template>

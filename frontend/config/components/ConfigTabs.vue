<script setup>
defineProps({
  tabs: { type: Array, default: () => [] },
  activeTab: { type: String, default: "shops" }
});

const emit = defineEmits(["change"]);
</script>

<template>
  <section class="vue-config-tabs-card">
    <div class="vue-config-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        type="button"
        class="vue-config-tab"
        :class="{ active: activeTab === tab.value }"
        @click="emit('change', tab.value)"
      >
        {{ tab.label }}
      </button>
    </div>
  </section>
</template>

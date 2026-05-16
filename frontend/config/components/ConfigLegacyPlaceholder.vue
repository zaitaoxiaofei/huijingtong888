<script setup>
defineProps({
  title: { type: String, default: "" },
  description: { type: String, default: "" },
  actionLabel: { type: String, default: "打开旧版" }
});

const emit = defineEmits(["open-legacy"]);
</script>

<template>
  <section class="ds-card vue-config-placeholder">
    <div class="ds-card-body vue-config-placeholder-body">
      <div>
        <h2>{{ title }}</h2>
        <p>{{ description }}</p>
      </div>
      <button type="button" class="ds-btn" @click="emit('open-legacy')">{{ actionLabel }}</button>
    </div>
  </section>
</template>

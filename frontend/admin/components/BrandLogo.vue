<script setup>
defineProps({
  collapsed: { type: Boolean, default: false }
});
</script>

<template>
  <span class="brand-logo" :class="{ 'is-collapsed': collapsed }" aria-hidden="true">
    <span class="brand-logo__mark">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path d="M12 2.75 21 7.75v8.5l-9 5-9-5v-8.5l9-5Z" />
        <path d="m3.5 8 8.5 4.75L20.5 8M12 12.75v8M7.5 5.25l9 5v4" />
      </svg>
    </span>
    <span v-if="!collapsed" class="brand-logo__wordmark">
      <strong>爆单</strong>
      <span class="brand-logo__erp">ERP</span>
    </span>
  </span>
</template>

<style scoped>
.brand-logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
  color: var(--erp-text-main, #1f2937);
  line-height: 1;
  white-space: nowrap;
  user-select: none;
}

.brand-logo__mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--erp-primary-soft, #f0efff);
  color: var(--erp-primary, #6258f6);
}

.brand-logo__mark svg {
  display: block;
  width: 22px;
  height: 22px;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.brand-logo__wordmark {
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
}

.brand-logo__wordmark strong {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.brand-logo__erp {
  color: var(--erp-text-regular, #4b5563);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.brand-logo.is-collapsed {
  gap: 0;
}
</style>

<script setup>
import { computed } from 'vue';
import { marketplaceIdentity } from '../../../src/shared/marketplace-identity.js';
const props = defineProps({ platform: { type: String, default: '' } });
const identity = computed(() => marketplaceIdentity(props.platform));
</script>

<template>
  <span class="marketplace-badge" :class="`marketplace-badge--${identity.key}`" :title="identity.label" :aria-label="`销售平台：${identity.label}`">{{ identity.label }}</span>
</template>

<style scoped>
.marketplace-badge{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;min-width:36px;height:22px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:800;line-height:1;letter-spacing:.3px;vertical-align:middle;color:#fff;background:#64748b}
.marketplace-badge--ozon{background:#005bff}.marketplace-badge--wb{background:linear-gradient(115deg,#cb11ab,#7c1db8)}
</style>

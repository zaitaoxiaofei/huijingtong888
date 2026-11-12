<script setup>
import { computed } from 'vue';
import { marketplaceIdentity } from '../../../src/shared/marketplace-identity.js';
import ozonLogo from '../assets/marketplaces/ozon.png';
import wbLogo from '../assets/marketplaces/wb.png';
const props = defineProps({ platform: { type: String, default: '' }, size: { type: Number, default: 28 } });
const identity = computed(() => marketplaceIdentity(props.platform));
const logo = computed(() => ({ ozon: ozonLogo, wb: wbLogo }[identity.value.key]));
</script>
<template>
  <span class="marketplace-badge" :class="`marketplace-badge--${identity.key}`" :style="{ '--marketplace-logo-size': `${size}px` }" :title="identity.label" :aria-label="`销售平台：${identity.label}`">
    <img v-if="logo" :src="logo" :alt="`${identity.label} 官方 Logo`" width="28" height="28" decoding="async" />
    <span v-else class="marketplace-unknown">{{ identity.label }}</span>
  </span>
</template>
<style scoped>
.marketplace-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;width:var(--marketplace-logo-size,28px);height:var(--marketplace-logo-size,28px);vertical-align:middle;border-radius:7px;overflow:hidden;line-height:1}
.marketplace-badge img{display:block;width:100%;height:100%;object-fit:contain;filter:none!important}
.marketplace-badge--unknown{width:auto;min-width:40px;padding:0 7px;background:var(--el-fill-color);color:var(--el-text-color-secondary);font-size:11px}
</style>

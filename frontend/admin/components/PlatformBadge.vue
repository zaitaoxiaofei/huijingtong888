<script setup>
import { computed } from 'vue';
import ozonIcon from '../assets/platforms/ozon.svg';
import wbIcon from '../assets/platforms/wb.png';

const props = defineProps({ platform: String, size: { type: Number, default: 26 } });
const brand = computed(() => ({
  ozon: { name: 'Ozon', icon: ozonIcon },
  wb: { name: 'Wildberries（WB）', icon: wbIcon }
})[String(props.platform || '').toLowerCase()] || { name: '平台待确认', icon: '' });
</script>

<template>
  <span class="platform-badge" role="img" :aria-label="brand.name" :title="brand.name"
    :style="{ width: `${size}px`, height: `${size}px` }">
    <img v-if="brand.icon" :src="brand.icon" alt="" aria-hidden="true" width="26" height="26" />
    <span v-else aria-hidden="true">?</span>
  </span>
</template>

<style scoped>
.platform-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;overflow:hidden;border-radius:6px;background:#fff;vertical-align:middle;box-shadow:0 0 0 1px rgb(128 146 171 / 16%);color:#64748b;font-size:12px;line-height:1}
.platform-badge img{display:block;width:100%;height:100%;object-fit:contain}
</style>

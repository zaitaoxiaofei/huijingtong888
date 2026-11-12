<script setup>
import { ref, defineAsyncComponent } from 'vue';
import MarketplaceSwitcher from '../../components/MarketplaceSwitcher.vue';
import OzonActionsView from './OzonActionsView.vue';
const WbActionsView=defineAsyncComponent(()=>import('./WbActionsView.vue'));
const platform=ref('ozon');
</script>
<template><div><MarketplaceSwitcher v-model="platform" label="活动平台" style="margin-bottom:16px" /><KeepAlive><OzonActionsView v-if="platform==='ozon'"/><WbActionsView v-else/></KeepAlive></div></template>

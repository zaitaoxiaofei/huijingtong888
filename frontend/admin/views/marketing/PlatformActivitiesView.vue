<script setup>
import { ref, defineAsyncComponent } from 'vue';
import OzonActionsView from './OzonActionsView.vue';
const WbActionsView=defineAsyncComponent(()=>import('./WbActionsView.vue'));
const platform=ref('ozon');
</script>
<template><div><el-tabs v-model="platform"><el-tab-pane label="Ozon" name="ozon"/><el-tab-pane label="WB" name="wb"/></el-tabs><KeepAlive><OzonActionsView v-if="platform==='ozon'"/><WbActionsView v-else/></KeepAlive></div></template>

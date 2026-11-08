<script setup>
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { apiClient } from '../../utils/api.js';
import WorkflowValuePreview from './WorkflowValuePreview.vue';
const props=defineProps({disabled:Boolean}),emit=defineEmits(['choose']);
const open=ref(false),loading=ref(false),rows=ref([]),keyword=ref('');
const visible=computed(()=>rows.value.filter(r=>`${r.name} ${r.facts}`.toLocaleLowerCase().includes(keyword.value.toLocaleLowerCase())));
async function show(){open.value=true;loading.value=true;try{rows.value=await apiClient.get('/api/product-workflows/facts-history',{noCache:true});}catch(e){ElMessage.error(e.message);}finally{loading.value=false;}}
</script>
<template><div><el-button link type="primary" :disabled="disabled" @click="show">复用历史卖点</el-button><el-dialog v-model="open" title="选择历史卖点" width="760px" top="5vh" append-to-body><div v-loading="loading"><el-input v-model="keyword" clearable placeholder="搜索历史生产名称或卖点"/><el-empty v-if="!visible.length&&!loading" description="还没有可复用的历史卖点"/><div class="facts-history"><article v-for="row in visible" :key="row.id"><strong>{{ row.name }} · {{ row.product }}</strong><WorkflowValuePreview :value="row.facts" label="历史填写的卖点"/><el-button type="primary" plain @click="emit('choose',row.facts);open=false">使用这份卖点</el-button></article></div></div></el-dialog></div></template>
<style scoped>.facts-history{max-height:60vh;overflow:auto}article{padding:14px 0;border-bottom:1px solid var(--el-border-color-lighter)}article strong{font-size:13px;display:block;margin-bottom:10px}article>.el-button{margin-top:10px}</style>

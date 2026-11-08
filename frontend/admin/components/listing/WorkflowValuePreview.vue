<script setup>
import { computed, ref } from 'vue';
import { withImageToken } from '../../api/tools/imageCropper.js';
const props=defineProps({value:{default:''},format:{type:String,default:'text'},label:{type:String,default:'内容预览'},unit:{type:String,default:''}});
const open=ref(false),images=computed(()=>Array.isArray(props.value)?props.value.filter(Boolean):[]);
const text=computed(()=>Array.isArray(props.value)?props.value.join('、'):String(props.value??''));
</script>
<template><div class="value-preview"><div v-if="format==='images'" class="preview-images"><el-image v-for="(url,i) in images" :key="url" :src="withImageToken(url)" :preview-src-list="images.map(withImageToken)" :initial-index="i" preview-teleported fit="contain"/><small v-if="!images.length">尚无图片</small></div><template v-else><div class="preview-label">{{ label }}<el-button v-if="text" link type="primary" @click="open=true">查看全文</el-button></div><p>{{ text||'尚未填写' }}{{ text&&unit?' '+unit:'' }}</p><el-dialog v-model="open" :title="label" width="640px" append-to-body><div class="full-text">{{ text }}{{ unit?' '+unit:'' }}</div></el-dialog></template></div></template>
<style scoped>.value-preview{padding:10px;background:var(--el-fill-color-lighter);border-radius:6px;min-width:0}.preview-label{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--el-text-color-secondary)}p{white-space:pre-wrap;overflow-wrap:anywhere;max-height:100px;overflow:auto;margin:6px 0;font-size:13px;line-height:1.7}.full-text{white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto;line-height:1.8}.preview-images{display:flex;flex-wrap:wrap;gap:8px}.preview-images .el-image{width:64px;height:84px}small{color:var(--el-text-color-secondary)}</style>

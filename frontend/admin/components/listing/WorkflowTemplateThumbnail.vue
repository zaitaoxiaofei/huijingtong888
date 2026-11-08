<script setup>
import { withImageToken } from '../../api/tools/imageCropper.js';
defineProps({url:{type:String,default:''}});
</script>
<template><div class="template-thumbnail"><el-image v-if="url" :src="withImageToken(url)" :preview-src-list="[withImageToken(url)]" preview-teleported fit="contain"><template #error><span>图片暂不可用</span></template></el-image><span v-else>暂无<br/>效果图</span></div></template>
<style scoped>.template-thumbnail{width:64px;height:84px;display:grid;place-items:center;background:var(--el-fill-color-light);border:1px solid var(--el-border-color-lighter);border-radius:6px;overflow:hidden}.el-image{width:100%;height:100%}span{font-size:12px;line-height:1.6;text-align:center;color:var(--el-text-color-secondary)}</style>

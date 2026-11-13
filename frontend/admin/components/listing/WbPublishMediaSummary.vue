<script setup>
import WbVideoPlayer from './WbVideoPlayer.vue';
defineProps({row:{type:Object,required:true},phase:{type:String,default:''}});
</script>
<template><div class="publish-media-summary"><p>本次提交资料：{{row.images?.length||0}} 张图片 / {{row.video_url?1:0}} 个视频</p><p v-if="phase==='card'">正在核对商品卡，尚未执行图片、视频上传。</p><p v-else-if="phase==='media'">正在核对 WB 图片、视频上传结果。</p><el-image v-for="(image,index) in row.images||[]" :key="image" :src="image" :preview-src-list="row.images" :initial-index="index" preview-teleported fit="cover"/><WbVideoPlayer v-if="row.video_url" :src="row.video_url"/></div></template>
<style scoped>.publish-media-summary{margin:12px 0}.publish-media-summary p{font-size:13px;color:var(--el-text-color-secondary)}.publish-media-summary .el-image{width:64px;height:84px;margin:4px;border-radius:4px}.publish-media-summary video{display:block;max-width:100%;max-height:240px;margin-top:8px}</style>

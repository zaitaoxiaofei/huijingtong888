<script setup>
import{onMounted,onBeforeUnmount,ref,watch}from'vue';import{createWbVideoPlayer}from'../../utils/wb-video-player.js';
const props=defineProps({src:{type:String,required:true}}),video=ref(null),error=ref('');const player=createWbVideoPlayer({onError:message=>error.value=message});
function load(){error.value='';if(video.value)player.setSource(video.value,props.src);}
onMounted(load);watch(()=>props.src,load);onBeforeUnmount(()=>{player.stop();video.value?.pause();video.value?.removeAttribute('src');video.value?.load();});
</script>
<template><div><video ref="video" controls preload="metadata" playsinline/><p v-if="error" class="video-error">{{error}} <el-button link type="primary" @click="load">重试</el-button></p></div></template>
<style scoped>video{display:block;max-width:100%;max-height:240px;margin-top:8px}.video-error{font-size:12px;color:var(--el-color-warning)}</style>

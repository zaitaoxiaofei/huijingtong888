<script setup>
import {computed} from 'vue';
const props=defineProps({src:{type:String,default:''},alt:{type:String,default:'商品主图'},hero:Boolean});
// Reuse the product's existing URL. Never proxy, download or persist image bytes.
const url=computed(()=>{const value=String(props.src||'').trim();return /^(https?:\/\/|\/(?!\/))/i.test(value)?value:'';});
</script>
<template>
 <div class="traffic-product-image" :class="{hero}">
  <el-image v-if="url" :src="url" :alt="alt" fit="cover" loading="lazy" :preview-src-list="[url]" :initial-index="0" preview-teleported><template #error><span class="image-placeholder">图片暂不可用</span></template></el-image>
  <span v-else class="image-placeholder">无图</span>
 </div>
</template>
<style scoped>
.traffic-product-image{width:64px;height:84px;flex:0 0 64px;overflow:hidden;border-radius:8px;border:1px solid var(--erp-border);background:var(--erp-surface-alt)}.traffic-product-image .el-image{width:100%;height:100%;display:block;cursor:zoom-in}.image-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:6px;color:var(--erp-text-secondary);font-size:11px;line-height:1.5}.hero{width:132px;height:168px;flex-basis:132px;border-radius:12px}@media(max-width:767px){.hero{width:90px;height:118px;flex-basis:90px}}
</style>

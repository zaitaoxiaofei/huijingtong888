<script setup>
import { ImagePlus, Layers3, Sparkles } from "lucide-vue-next";
</script>

<template>
  <div class="ai-empty-state">
    <div class="empty-visual">
      <div class="visual-card card-a"><ImagePlus :size="34" /></div>
      <div class="visual-card card-b"><Layers3 :size="30" /></div>
      <div class="visual-core"><Sparkles :size="30" /></div>
    </div>
    <h2>上传一张电商套图开始拆分</h2>
    <p>结果会以图片网格展示在这里。每张图片都可以预览、下载或删除。</p>
  </div>
</template>

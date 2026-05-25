<script setup>
import { Activity, Clock3, Download, History, Sparkles } from "lucide-vue-next";

defineProps({
  statusText: { type: String, required: true },
  taskCount: { type: Number, default: 0 },
  canDownload: { type: Boolean, default: false },
  zipUrl: { type: String, default: "" }
});
</script>

<template>
  <header class="ai-topbar">
    <div class="brand-lockup">
      <div class="brand-orb">
        <Sparkles :size="22" />
      </div>
      <div>
        <div class="eyebrow">AI Image Workflow</div>
        <h1>电商套图拆分器</h1>
        <p>上传套图，选择工作流，生成可下载的独立商品图。</p>
      </div>
    </div>

    <div class="topbar-meta">
      <div class="status-pill">
        <Activity :size="15" />
        <span>{{ statusText }}</span>
      </div>
      <div class="metric-pill">
        <span>{{ taskCount }}</span>
        <small>输出图片</small>
      </div>
      <button class="ghost-chip" type="button">
        <History :size="16" />
        最近任务
      </button>
      <a class="download-chip" :class="{ disabled: !canDownload }" :href="canDownload ? zipUrl : undefined">
        <Download :size="16" />
        下载 ZIP
      </a>
      <div class="time-chip">
        <Clock3 :size="14" />
        V1 Splitter
      </div>
    </div>
  </header>
</template>

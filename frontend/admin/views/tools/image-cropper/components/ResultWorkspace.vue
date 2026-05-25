<script setup>
import { Download, ImageOff, Maximize2, Trash2 } from "lucide-vue-next";
import AiEmptyState from "./AiEmptyState.vue";
import { downloadUrl, withImageToken } from "../../../../api/tools/imageCropper";

defineProps({
  cropResults: { type: Array, default: () => [] },
  canDownload: { type: Boolean, default: false },
  zipUrl: { type: String, default: "" }
});

const emit = defineEmits(["remove"]);
</script>

<template>
  <main class="result-workspace">
    <div class="workspace-head">
      <div>
        <span>Result Workspace</span>
        <h2>拆分结果</h2>
      </div>
      <a class="workspace-download" :class="{ disabled: !canDownload }" :href="canDownload ? downloadUrl(zipUrl) : undefined">
        <Download :size="17" />
        全部打包
      </a>
    </div>

    <AiEmptyState v-if="!cropResults.length" />

    <div v-else class="result-grid">
      <article v-for="(crop, index) in cropResults" :key="crop.id" class="result-card">
        <div class="result-image">
          <el-image :src="withImageToken(crop.url)" fit="contain" :preview-src-list="cropResults.map(item => withImageToken(item.url))">
            <template #error>
              <div class="image-error"><ImageOff :size="30" /></div>
            </template>
          </el-image>
          <div class="hover-toolbar">
            <div class="preview-trigger">
              <Maximize2 :size="16" />
              <el-image class="preview-trigger-image" :src="withImageToken(crop.url)" :preview-src-list="cropResults.map(item => withImageToken(item.url))" />
            </div>
            <a :href="downloadUrl(crop.downloadUrl)" title="下载">
              <Download :size="16" />
            </a>
            <button type="button" title="删除" @click="emit('remove', crop.id)">
              <Trash2 :size="16" />
            </button>
          </div>
        </div>
        <footer>
          <div>
            <strong>Image {{ index + 1 }}</strong>
            <span>{{ crop.filename }}</span>
          </div>
          <small>{{ crop.width }} × {{ crop.height }}</small>
        </footer>
      </article>
    </div>
  </main>
</template>

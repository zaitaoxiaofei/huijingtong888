<script setup>
import { computed } from "vue";
import { Edit, Refresh, View } from "@element-plus/icons-vue";

const props = defineProps({
  previews: { type: Array, default: () => [] },
  generating: { type: Boolean, default: false }
});

defineEmits(["regenerate"]);

const visiblePreviews = computed(() => props.previews || []);

function tagType(status) {
  return {
    pending: "info",
    generating: "warning",
    success: "success",
    failed: "danger"
  }[status] || "info";
}

function statusText(status) {
  return {
    pending: "待生成",
    generating: "生成中",
    success: "已完成",
    failed: "失败"
  }[status] || status || "待生成";
}
</script>

<template>
  <section class="preview-panel">
    <div class="preview-head">
      <div>
        <span>REALTIME PREVIEW</span>
        <strong>实时预览区</strong>
      </div>
      <el-tag :type="generating ? 'warning' : 'info'" effect="dark">{{ generating ? "AI 批量生成中" : "等待任务" }}</el-tag>
    </div>

    <div class="preview-list">
      <article v-for="item in visiblePreviews" :key="item.id" class="preview-card" :class="item.status">
        <div class="preview-card-head">
          <div>
            <strong>{{ item.displayName }}</strong>
            <span>{{ item.stage }}</span>
          </div>
          <el-tag :type="tagType(item.status)" effect="plain">{{ statusText(item.status) }}</el-tag>
        </div>

        <div v-if="item.status === 'generating'" class="preview-skeleton">
          <el-skeleton animated>
            <template #template>
              <el-skeleton-item variant="image" class="skeleton-image" />
              <el-skeleton-item variant="h3" style="width: 82%" />
              <el-skeleton-item variant="text" style="width: 70%" />
              <el-skeleton-item variant="text" style="width: 48%" />
            </template>
          </el-skeleton>
          <el-progress :percentage="item.progress" :stroke-width="8" striped striped-flow />
        </div>

        <template v-else>
          <div class="image-stage">
            <img v-if="item.mainImageUrl" :src="item.mainImageUrl" alt="" />
            <div v-else class="image-empty">AI 主图待生成</div>
          </div>
          <div class="copy-preview">
            <label>标题预览</label>
            <strong>{{ item.title || "等待生成标题" }}</strong>
            <label>标签预览</label>
            <div class="tag-row">
              <el-tag v-for="tag in item.tags" :key="tag" size="small" effect="plain">{{ tag }}</el-tag>
              <span v-if="!item.tags?.length">等待生成标签</span>
            </div>
          </div>
        </template>

        <div class="preview-actions">
          <el-button class="erp-btn erp-btn-secondary" size="small" :icon="Refresh" @click="$emit('regenerate', item.targetId)">重新生成主图</el-button>
          <el-button class="erp-btn erp-btn-secondary" size="small" :icon="Edit">编辑标题</el-button>
          <el-button class="erp-btn erp-btn-secondary" size="small" :icon="Edit">编辑标签</el-button>
          <el-button class="erp-btn erp-btn-secondary" size="small" :icon="View">查看详情</el-button>
        </div>
      </article>

      <div v-if="!visiblePreviews.length" class="preview-empty-block">
        添加车型后，这里会实时出现 AI 生成任务卡片。
      </div>
    </div>
  </section>
</template>

<style scoped>
.preview-panel {
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 12px;
  background: #101827;
  color: #e5eefb;
  padding: 14px;
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.16);
}

.preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.preview-head div {
  display: grid;
  gap: 4px;
}

.preview-head span {
  color: #7dd3fc;
  font-size: 12px;
  font-weight: 800;
}

.preview-head strong {
  font-size: 18px;
}

.preview-list {
  display: grid;
  gap: 12px;
}

.preview-card {
  display: grid;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  background: #172033;
}

.preview-card.generating {
  border-color: rgba(250, 204, 21, 0.52);
  box-shadow: inset 0 0 0 1px rgba(250, 204, 21, 0.1);
}

.preview-card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
}

.preview-card-head div {
  display: grid;
  gap: 4px;
}

.preview-card-head strong {
  font-size: 20px;
}

.preview-card-head span {
  color: #94a3b8;
  font-size: 12px;
}

.image-stage,
.skeleton-image {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
  overflow: hidden;
  background: #0f172a;
}

.image-stage img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.image-empty,
.preview-empty-block {
  min-height: 180px;
  display: grid;
  place-items: center;
  color: #94a3b8;
  border: 1px dashed rgba(148, 163, 184, 0.28);
  border-radius: 8px;
}

.copy-preview {
  display: grid;
  gap: 7px;
}

.copy-preview label {
  color: #7dd3fc;
  font-size: 12px;
}

.copy-preview strong {
  line-height: 1.45;
}

.tag-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 24px;
}

.tag-row span {
  color: #94a3b8;
  font-size: 13px;
}

.preview-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>

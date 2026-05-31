<script setup>
import { computed } from "vue";
import { Delete, Refresh, ShoppingCart, Upload } from "@element-plus/icons-vue";

const props = defineProps({
  results: { type: Array, default: () => [] }
});

defineEmits(["write-back", "write-back-all", "enter-listing", "delete", "regenerate"]);

const visibleResults = computed(() => props.results.filter((item) => item.status !== "deleted"));

function statusType(value) {
  return {
    pending: "info",
    writing: "warning",
    written_back: "success",
    failed: "danger"
  }[value] || "info";
}

function writeBackText(value) {
  return {
    pending: "待回写",
    writing: "回写中",
    written_back: "已回写",
    failed: "回写失败"
  }[value] || "待回写";
}
</script>

<template>
  <section class="result-pool">
    <div class="pool-head">
      <div>
        <span>RESULT POOL</span>
        <strong>已生成商品池</strong>
      </div>
      <div>
        <el-button class="erp-btn erp-btn-secondary" :icon="ShoppingCart" @click="$emit('enter-listing')">批量进入上架</el-button>
        <el-button class="erp-btn erp-btn-secondary" type="success" :icon="Upload" @click="$emit('write-back-all')">批量回写</el-button>
      </div>
    </div>

    <div class="pool-grid">
      <article v-for="item in visibleResults" :key="item.id" class="pool-card">
        <img :src="item.mainImageUrl" alt="" />
        <div class="pool-body">
          <div class="pool-title">
            <strong>{{ item.productName }}</strong>
            <el-tag :type="statusType(item.writeBackStatus)" effect="plain">{{ writeBackText(item.writeBackStatus) }}</el-tag>
          </div>
          <div class="pool-facts">
            <span>品牌：{{ item.brand || "-" }}</span>
            <span>车型：{{ item.displayName || item.model || "-" }}</span>
            <span>详情图：{{ item.inheritDetailImages ? `继承 ${item.detailImageCount} 张` : "AI重新生成" }}</span>
            <span>标题：{{ item.titleStatus }}</span>
            <span>标签：{{ item.tagStatus }}</span>
            <span>视频：{{ item.videoStatus }}</span>
          </div>
          <div class="pool-actions">
            <el-button class="erp-btn erp-btn-secondary" size="small" type="success" :icon="Upload" :disabled="item.writeBackStatus === 'written_back'" @click="$emit('write-back', item)">回写到选品表</el-button>
            <el-button class="erp-btn erp-btn-secondary" size="small" :icon="Refresh" @click="$emit('regenerate', item.targetId)">重新生成</el-button>
            <el-button class="erp-btn erp-btn-danger" size="small" type="danger" :icon="Delete" @click="$emit('delete', item.id)">删除</el-button>
          </div>
        </div>
      </article>

      <div v-if="!visibleResults.length" class="pool-empty">
        生成完成的商品会进入这里，随后可以回写选品表或进入店铺上架流程。
      </div>
    </div>
  </section>
</template>

<style scoped>
.result-pool {
  margin: 0 16px 16px;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
}

.pool-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}

.pool-head > div:first-child {
  display: grid;
  gap: 4px;
}

.pool-head span {
  color: #2563eb;
  font-size: 12px;
  font-weight: 800;
}

.pool-head strong {
  color: #0f172a;
  font-size: 18px;
}

.pool-head > div:last-child,
.pool-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.pool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
}

.pool-card {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 12px;
  padding: 10px;
  border: 1px solid #dbe5ef;
  border-radius: 10px;
  background: #fff;
}

.pool-card img {
  width: 112px;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 8px;
  background: #f1f5f9;
}

.pool-body {
  display: grid;
  gap: 9px;
  min-width: 0;
}

.pool-title {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
}

.pool-title strong {
  min-width: 0;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.pool-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px 10px;
  color: #64748b;
  font-size: 12px;
}

.pool-empty {
  min-height: 120px;
  display: grid;
  place-items: center;
  color: #64748b;
  border: 1px dashed #cbd5e1;
  border-radius: 10px;
  background: #f8fbff;
}
</style>

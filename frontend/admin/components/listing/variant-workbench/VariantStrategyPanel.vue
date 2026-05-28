<script setup>
const model = defineModel({ type: Object, required: true });

const imageStyles = ["高端原厂风", "白底清晰风", "安装场景风", "Ozon爆款风", "自定义Prompt"];
</script>

<template>
  <section class="work-card">
    <div class="section-head">
      <span>03</span>
      <strong>生成策略</strong>
    </div>

    <div class="strategy-block">
      <h3>主图生成策略</h3>
      <div class="strategy-grid">
        <button
          v-for="style in imageStyles"
          :key="style"
          type="button"
          class="strategy-choice"
          :class="{ active: model.mainImageStyle === style }"
          @click="model.mainImageStyle = style"
        >
          {{ style }}
        </button>
      </div>
      <el-input
        v-if="model.mainImageStyle === '自定义Prompt'"
        v-model="model.customPrompt"
        type="textarea"
        :rows="3"
        placeholder="描述主图构图、背景、光线、文字区域和平台风格"
      />
    </div>

    <div class="strategy-block compact">
      <h3>详情图策略</h3>
      <el-segmented
        v-model="model.detailImageStrategy"
        :options="[
          { label: '继承母商品', value: 'inherit' },
          { label: 'AI重新生成', value: 'regenerate' }
        ]"
      />
    </div>

    <div class="strategy-block">
      <h3>文案策略</h3>
      <div class="switch-list">
        <label><span>标题重新生成</span><el-switch v-model="model.copyStrategy.title" /></label>
        <label><span>标签重新生成</span><el-switch v-model="model.copyStrategy.tags" /></label>
        <label><span>描述替换品牌车型</span><el-switch v-model="model.copyStrategy.description" /></label>
        <label><span>同步生成视频占位</span><el-switch v-model="model.generateVideo" /></label>
      </div>
    </div>

    <div class="strategy-block compact">
      <h3>回写策略</h3>
      <el-segmented
        v-model="model.writeBackMode"
        :options="[
          { label: '自动回写选品表', value: 'auto' },
          { label: '仅保存主图方案', value: 'plan_only' }
        ]"
      />
    </div>
  </section>
</template>

<style scoped>
.work-card {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.78);
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.06);
  padding: 14px;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.section-head span {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: #0f172a;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
}

.strategy-block {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid #dbe5ef;
  border-radius: 8px;
  background: #f8fbff;
}

.strategy-block + .strategy-block {
  margin-top: 10px;
}

.strategy-block h3 {
  margin: 0;
  color: #0f172a;
  font-size: 14px;
}

.strategy-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.strategy-choice {
  min-height: 48px;
  border: 1px solid #dbe5ef;
  border-radius: 7px;
  background: #fff;
  color: #334155;
  cursor: pointer;
  font-weight: 600;
}

.strategy-choice.active {
  color: #fff;
  background: #2563eb;
  border-color: #2563eb;
}

.switch-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.switch-list label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 7px;
  background: #fff;
  border: 1px solid #e2e8f0;
}

.switch-list span {
  color: #334155;
  font-size: 13px;
}

@media (max-width: 1400px) {
  .strategy-grid,
  .switch-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

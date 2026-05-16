<script setup>
import ConfigHistoricalProfitReview from "./ConfigHistoricalProfitReview.vue";

defineProps({
  metrics: { type: Object, default: () => ({}) },
  steps: { type: Array, default: () => [] },
  financeSummary: { type: Object, default: () => ({ badges: [], rows: [] }) },
  reviewSummary: { type: Object, default: () => ({}) },
  reviewRows: { type: Array, default: () => [] },
  reviewSelectedIds: { type: Array, default: () => [] }
});

const emit = defineEmits([
  "sync-finance",
  "recalculate-historical",
  "cleanup-loss",
  "refresh-review",
  "toggle-review-all",
  "toggle-review-row",
  "review-action",
  "open-review-order"
]);
</script>

<template>
  <section class="vue-config-profit-grid">
    <section class="ds-card vue-config-profit-card">
      <div class="ds-card-body">
        <div class="vue-config-summary">
          <span class="ds-badge ds-badge-info">当前汇率 {{ metrics.rateText || "--" }}</span>
          <span class="ds-badge ds-badge-info">已同步佣金 SKU {{ metrics.commissionSkuCount || 0 }}</span>
          <span class="ds-badge ds-badge-success">绑定可用佣金 {{ metrics.productsWithRule || 0 }}</span>
          <span class="ds-badge ds-badge-warning">平均佣金 {{ metrics.avgCommissionText || "--" }}</span>
        </div>
      </div>
    </section>

    <section class="vue-config-profit-cards">
      <article class="ds-card vue-config-profit-card">
        <div class="ds-card-body">
          <h3>当前预估利润公式</h3>
          <p>销售收入 - 采购成本 - 国内运费 - 国际物流 - Ozon 佣金 - 尾程+银行 - 退货预损 = 预估利润</p>
        </div>
      </article>
      <article class="ds-card vue-config-profit-card">
        <div class="ds-card-body">
          <h3>实际利润目标模型</h3>
          <p>订单收入 - 真实采购 - 真实 Ozon 费用 - 真实物流/退货 + 补偿调整 = 实际利润</p>
        </div>
      </article>
    </section>

    <section class="vue-config-profit-steps">
      <article v-for="step in steps" :key="step.title" class="ds-card vue-config-profit-step">
        <div class="ds-card-body">
          <span class="ds-badge ds-badge-info">{{ step.status }}</span>
          <h3>{{ step.title }}</h3>
          <p>{{ step.text }}</p>
        </div>
      </article>
    </section>

    <section class="ds-card vue-config-profit-finance">
      <div class="ds-card-header">
        <div>
          <h2>Ozon 真实财务明细</h2>
        </div>
        <div class="ds-card-actions">
          <button type="button" class="ds-btn ds-btn-small" @click="emit('recalculate-historical')">历史强制重算</button>
          <button type="button" class="ds-btn ds-btn-small" @click="emit('cleanup-loss')">清理历史售后残留</button>
          <button type="button" class="ds-btn ds-btn-primary" @click="emit('sync-finance')">同步当前利润区间财务</button>
        </div>
      </div>
      <div class="ds-card-body">
        <div class="vue-config-summary">
          <span
            v-for="item in financeSummary.badges || []"
            :key="`${item.label}-${item.value}`"
            class="ds-badge"
            :class="item.tone ? `ds-badge-${item.tone}` : 'ds-badge-info'"
          >
            {{ item.label }} {{ item.value }}
          </span>
        </div>
        <div v-if="financeSummary.rows?.length" class="ds-table-wrap">
          <table class="ds-table vue-config-table">
            <thead>
              <tr>
                <th>货件编号</th>
                <th>店铺</th>
                <th>财务日期</th>
                <th>费用</th>
                <th>行数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in financeSummary.rows" :key="`${row.posting_number}-${row.operation_date}`">
                <td>{{ row.posting_number || "-" }}</td>
                <td>{{ row.shop_name || "-" }}</td>
                <td>{{ row.operation_date || "-" }}</td>
                <td>{{ row.fee_amount || "-" }}</td>
                <td>{{ row.rows || 0 }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="ds-empty vue-config-empty">还没有同步 Ozon 财务明细。</div>
      </div>
    </section>

    <ConfigHistoricalProfitReview
      :summary="reviewSummary"
      :rows="reviewRows"
      :selected-ids="reviewSelectedIds"
      @refresh="emit('refresh-review')"
      @toggle-all="emit('toggle-review-all', $event)"
      @toggle-row="emit('toggle-review-row', $event)"
      @run-action="emit('review-action', $event)"
      @open-order="emit('open-review-order', $event)"
    />
  </section>
</template>

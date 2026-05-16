<script setup>
const props = defineProps({
  summary: {
    type: Object,
    default: () => ({})
  },
  rows: {
    type: Array,
    default: () => []
  },
  selectedIds: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(["refresh", "toggle-all", "toggle-row", "run-action", "open-order"]);

function isChecked(id) {
  return props.selectedIds.includes(Number(id));
}
</script>

<template>
  <section class="ds-card vue-config-profit-review">
    <div class="ds-card-header">
      <div>
        <h2>历史利润复核</h2>
        <p>对历史已完成订单中残留的售后损失做批量复核、重算、保留和清零。</p>
      </div>
      <div class="ds-card-actions">
        <button type="button" class="ds-btn ds-btn-small" @click="emit('refresh')">刷新复核区</button>
        <button type="button" class="ds-btn ds-btn-small" :disabled="!selectedIds.length" @click="emit('run-action', 'recalculate')">批量重算</button>
        <button type="button" class="ds-btn ds-btn-small" :disabled="!selectedIds.length" @click="emit('run-action', 'keep')">标记保留</button>
        <button type="button" class="ds-btn ds-btn-small" :disabled="!selectedIds.length" @click="emit('run-action', 'clear')">确认清零</button>
        <button type="button" class="ds-btn ds-btn-small" :disabled="!selectedIds.length" @click="emit('run-action', 'reset')">重置复核</button>
      </div>
    </div>
    <div class="ds-card-body">
      <div class="vue-config-summary">
        <span class="ds-badge ds-badge-info">待复核明细 {{ summary.total_rows || 0 }}</span>
        <span class="ds-badge ds-badge-warning">待处理 {{ summary.pending_rows || 0 }}</span>
        <span class="ds-badge ds-badge-success">已保留 {{ summary.kept_rows || 0 }}</span>
        <span class="ds-badge ds-badge-danger">售后残留 {{ summary.total_return_loss_cny_text || "-" }}</span>
      </div>
      <div v-if="rows.length" class="ds-table-wrap">
        <table class="ds-table vue-config-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  :checked="selectedIds.length > 0 && selectedIds.length === rows.length"
                  @change="emit('toggle-all', $event.target.checked)"
                />
              </th>
              <th>订单 / 商品</th>
              <th>店铺 / 时间</th>
              <th>状态</th>
              <th>售后残留</th>
              <th>当前利润</th>
              <th>财务线索</th>
              <th>复核状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.order_item_id">
              <td>
                <input
                  type="checkbox"
                  :checked="isChecked(row.order_item_id)"
                  @change="emit('toggle-row', { id: row.order_item_id, checked: $event.target.checked })"
                />
              </td>
              <td>
                <div class="vue-config-review-order">
                  <img v-if="row.image_url" :src="row.image_url" alt="" />
                  <div>
                    <strong>{{ row.posting_number || "-" }}</strong>
                    <small>{{ row.ozon_sku || "-" }} / {{ row.product_name || row.ozon_name || "-" }}</small>
                  </div>
                </div>
              </td>
              <td>
                <strong>{{ row.shop_name || "-" }}</strong>
                <div class="vue-config-cell-meta">下单 {{ row.ordered_at_text || row.order_date || "-" }}</div>
              </td>
              <td>
                <strong>{{ row.status_text || row.status || "-" }}</strong>
                <div class="vue-config-cell-meta">{{ row.bucket_label || "-" }}</div>
              </td>
              <td>{{ row.return_loss_cny_text || "-" }}</td>
              <td>
                <strong>{{ row.net_profit_cny_text || "-" }}</strong>
                <div class="vue-config-cell-meta">{{ row.profit_status_text || row.profit_status || "-" }}</div>
              </td>
              <td>
                <strong>{{ row.finance_rows || 0 }} 条</strong>
                <div class="vue-config-cell-meta">{{ row.finance_service_names || "暂无真实财务线索" }}</div>
              </td>
              <td>
                <strong>{{ row.review_status_text || "-" }}</strong>
                <div class="vue-config-cell-meta">{{ row.review_note || "-" }}</div>
              </td>
              <td>
                <button type="button" class="ds-btn ds-btn-ghost ds-btn-small" @click="emit('open-order', row.order_id)">查看订单</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="ds-empty vue-config-empty">当前时间范围内没有待复核的历史利润残留。</div>
    </div>
  </section>
</template>

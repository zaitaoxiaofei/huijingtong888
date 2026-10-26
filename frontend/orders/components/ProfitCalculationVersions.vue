<script setup>
import { computed, ref } from "vue";
import { shanghaiDateText, shanghaiDateTimeText } from "../../admin/utils/shanghai-date.js";
import { calculationSnapshotRows, dailyFxEvidenceRows, dailyFxPendingText, fxAttributionRows, versionReferenceText } from "../utils/profit-calculation-versions.js";

const props = defineProps({
  payload: { type: Object, default: () => ({ available: false, items: [] }) },
  fx: { type: Object, default: null },
  items: { type: Array, default: () => [] }
});
const expandedRevisions = ref({});
const records = computed(() => (props.payload?.items || []).map((record) => ({
  ...record,
  item: props.items.find((item) => Number(item.id) === Number(record.order_item_id)) || {},
  revisions: Array.isArray(record.revisions) ? record.revisions : []
})));
const formatTime = (value) => shanghaiDateTimeText(value, { assumeUtcWhenNaive: true });
const formatBusinessDate = (value) => shanghaiDateText(`${value}T00:00:00+08:00`);
const sourceLabels = { legacy_baseline: "历史基线", order_created: "订单首次预估", order_sync: "订单同步", order_recalculation: "按原版本重算", estimate_recalculation: "按原版本重算", finance_application: "财务结算", ozon_finance: "Ozon账单结算", ozon_finance_daily_fx: "每日汇率账单结算", manual_recalculation: "按原版本重算", historical_repair: "历史利润修订", terminal_no_revenue_repair: "售后订单历史修订" };
const reasonText = (revision) => revision.reason === "Preserved existing values without recalculation" ? "保留已有金额，未重新计算" : revision.reason || "未记录";
</script>

<template>
  <div class="profit-calculation-versions">
    <template v-if="fx">
      <h4>每日汇率计算依据</h4>
      <p>预估采用下单日汇率；签收后冻结签收日汇率，完整账单到齐后核算真实利润。</p>
      <p v-if="dailyFxPendingText(fx)">{{ dailyFxPendingText(fx) }}</p>
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item v-for="row in dailyFxEvidenceRows(fx, formatBusinessDate)" :key="row.label" :label="row.label">{{ row.value }}</el-descriptions-item>
      </el-descriptions>
    </template>
    <p v-if="!payload?.available || !records.length">当前没有版本记录；原利润明细和已保存金额仍按上方展示。</p>
    <article v-for="record in records" :key="record.order_item_id" class="profit-calculation-item">
      <strong>{{ record.item.product_name || record.item.ozon_name || '订单商品' }} · SKU {{ record.item.ozon_sku || '未记录' }}</strong>
      <p>{{ record.formula_version || 'V1' }}<span v-if="record.legacy_baseline"> · 历史基线，历史计算输入未完整留存</span></p>
      <p v-if="record.truncated">展示最近 {{ record.revisions.length }} 条，共 {{ record.history_count }} 条记录。</p>
      <el-empty v-if="!record.revisions.length" description="暂无计算修订记录" :image-size="48" />
      <details v-for="revision in record.revisions" :key="revision.id || revision.revision_no" class="profit-calculation-revision" @toggle="expandedRevisions[`${record.order_item_id}:${revision.id || revision.revision_no}`] = $event.target.open">
        <summary>
          {{ revision.formula_version || record.formula_version || 'V1' }} · {{ revision.layer === 'actual' ? '真实结算' : '预估' }} · 修订 {{ revision.revision_no }} · {{ formatTime(revision.created_at) }}（北京时间）
        </summary>
        <template v-if="expandedRevisions[`${record.order_item_id}:${revision.id || revision.revision_no}`]">
        <p v-if="revision.legacy_baseline || revision.input_completeness === 'legacy_unknown'">历史基线：保存当时已有结果，历史输入未完整留存。</p>
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="计算来源">{{ sourceLabels[revision.source] || revision.source || '未记录' }}</el-descriptions-item>
          <el-descriptions-item label="变更原因">{{ reasonText(revision) }}</el-descriptions-item>
          <el-descriptions-item label="费率版本">{{ versionReferenceText(revision.rate_version) }}</el-descriptions-item>
          <el-descriptions-item label="成本版本">{{ versionReferenceText(revision.cost_version) }}</el-descriptions-item>
          <el-descriptions-item label="操作人">{{ revision.actor_id ? `人员 #${revision.actor_id}` : '系统' }}</el-descriptions-item>
          <el-descriptions-item label="当前采用">{{ Number(record.current_estimate_revision_id) === Number(revision.id) ? '当前预估' : Number(record.current_actual_revision_id) === Number(revision.id) ? '当前真实' : '历史记录' }}</el-descriptions-item>
        </el-descriptions>
        <h4>计算输入</h4>
        <el-table v-if="calculationSnapshotRows(revision.inputs, formatTime).length" :data="calculationSnapshotRows(revision.inputs, formatTime)" border size="small">
          <el-table-column prop="label" label="依据" min-width="160" />
          <el-table-column prop="value" label="保存值" min-width="180" />
        </el-table>
        <p v-else>历史输入未完整留存</p>
        <h4>保存结果</h4>
        <el-table v-if="calculationSnapshotRows(revision.outputs, formatTime).length" :data="calculationSnapshotRows(revision.outputs, formatTime)" border size="small">
          <el-table-column prop="label" label="项目" min-width="160" />
          <el-table-column prop="value" label="保存值" min-width="180" />
        </el-table>
        <p v-else>未记录分项结果</p>
        <template v-if="fxAttributionRows(revision).length">
          <h4>真实利润差异拆分</h4>
          <p>汇率波动损益仅改变同一笔实际原币净额的汇率；业务变化差额包含售价、费用和成本变化。</p>
          <el-table :data="fxAttributionRows(revision)" border size="small">
            <el-table-column prop="label" label="差异来源" min-width="180" />
            <el-table-column prop="value" label="人民币金额" min-width="160" />
          </el-table>
        </template>
        </template>
      </details>
    </article>
  </div>
</template>

<style scoped>
.profit-calculation-versions { padding: 12px 0; color: var(--erp-text-regular, #475467); font-size: 13px; }
.profit-calculation-item + .profit-calculation-item { margin-top: 16px; }
.profit-calculation-revision { margin-top: 8px; padding: 10px; border: 1px solid var(--erp-border, #e4e7ec); border-radius: 6px; }
summary { cursor: pointer; line-height: 1.6; }
h4 { margin: 14px 0 8px; }
</style>

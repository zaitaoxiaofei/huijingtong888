<script setup>
import { computed, defineAsyncComponent, ref } from 'vue';
import { mobileOrderProfitDetail, profitRowValue } from '../../views/mobile/mobile-order-profit.js';

const ProfitCalculationVersions = defineAsyncComponent(() => import('../../../orders/components/ProfitCalculationVersions.vue'));
const props = defineProps({ detail: { type: Object, default: null } });
const expanded = ref(false);
const profit = computed(() => mobileOrderProfitDetail(props.detail));
const row = key => profit.value?.rows.find(item => item.key === key);
const metrics = computed(() => [
  { key: 'estimate', label: '预估利润', value: profitRowValue(row('profit'), 'estimated') },
  { key: 'actual', label: '实际利润', value: profit.value?.summary.actualProfitReady ? profitRowValue(row('profit'), 'actual') : '待结算' },
  { key: 'sale', label: '预估销售额', value: profitRowValue(row('sale'), 'estimated') },
  { key: 'cost', label: '预估总成本', value: profitRowValue(row('costTotal'), 'estimated') }
]);
</script>

<template>
  <section class="mobile-order-profit" aria-labelledby="mobile-order-profit-title">
    <header class="mobile-order-profit__head">
      <h2 id="mobile-order-profit-title">订单利润明细</h2>
      <span>CNY · 整单</span>
    </header>
    <template v-if="profit">
      <p class="mobile-order-profit__intro">全部 {{ detail.items?.length || 0 }} 项商品合计，沿用订单已保存的预估模型和结算明细。</p>
      <div class="mobile-order-profit__metrics">
        <div v-for="metric in metrics" :key="metric.key" :data-metric="metric.key">
          <span>{{ metric.label }}</span><strong>{{ metric.value }}</strong>
        </div>
      </div>
      <p class="mobile-order-profit__state">{{ profit.summary.actualProfitReady ? '实际利润已按订单结算口径核算。' : '实际利润待完整财务结算；已匹配的真实费用在下方逐项展示。' }}</p>
      <div class="mobile-order-profit__rows" role="list" aria-label="费用比较明细">
        <article v-for="item in profit.rows" :key="item.key" :data-profit-row="item.key" class="mobile-order-profit__row" :class="{ 'is-total': item.strong }" role="listitem">
          <h3>{{ item.label }}</h3>
          <dl>
            <div><dt>预估金额</dt><dd>{{ profitRowValue(item, 'estimated') }}</dd></div>
            <div><dt>真实金额</dt><dd>{{ profitRowValue(item, 'actual') }}</dd></div>
            <div><dt>差异</dt><dd>{{ profitRowValue(item, 'diff') }}</dd></div>
          </dl>
          <p v-if="item.note">{{ item.note }}</p>
        </article>
      </div>
      <details class="mobile-order-profit__versions" @toggle="expanded = $event.target.open">
        <summary>计算依据与版本记录</summary>
        <ProfitCalculationVersions v-if="expanded" :key="detail.order?.id" :payload="detail.profit_calculation_versions || { available: false, items: [] }" :fx="detail.profit_fx || null" :items="detail.items || []" />
      </details>
    </template>
    <p v-else class="mobile-order-profit__empty">暂未取得订单预估明细，请稍后重新打开详情；未记录的金额不按 0 展示。</p>
  </section>
</template>

<style scoped>
.mobile-order-profit { min-width: 0; padding: 14px; border: 1px solid var(--erp-detail-primary-border, #dbe3ef); border-radius: 14px; background: var(--erp-detail-surface, #fff); color: var(--erp-detail-text-main, #172033); }
.mobile-order-profit__head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
h2 { margin: 0; font-size: 16px; }
.mobile-order-profit__head > span { flex-shrink: 0; font-size: 12px; }
.mobile-order-profit__intro, .mobile-order-profit__state, .mobile-order-profit__empty { color: var(--erp-detail-text-regular, #64748b); font-size: 12px; line-height: 1.6; }
.mobile-order-profit__metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mobile-order-profit__metrics > div { display: grid; gap: 6px; padding: 12px; border-radius: 10px; background: var(--erp-detail-surface-alt, #f8fafc); }
.mobile-order-profit__metrics span { font-size: 12px; color: var(--erp-detail-text-regular, #64748b); }
.mobile-order-profit__metrics strong { font-size: 17px; overflow-wrap: anywhere; }
.mobile-order-profit__rows { display: grid; gap: 8px; }
.mobile-order-profit__row { min-width: 0; padding: 10px; border: 1px solid var(--erp-detail-primary-border, #dbe3ef); border-radius: 10px; }
.mobile-order-profit__row.is-total { background: var(--erp-detail-surface-alt, #f8fafc); }
h3 { margin: 0 0 9px; font-size: 14px; }
dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; }
dl > div { min-width: 0; }
dt { font-size: 11px; color: var(--erp-detail-text-regular, #64748b); }
dd { margin: 5px 0 0; font-size: 12px; font-weight: 700; line-height: 1.5; overflow-wrap: anywhere; }
.mobile-order-profit__row > p { margin: 9px 0 0; font-size: 11px; line-height: 1.6; color: var(--erp-detail-text-regular, #64748b); }
.mobile-order-profit__versions { min-width: 0; margin-top: 12px; }
.mobile-order-profit__versions > summary { padding: 10px 0; cursor: pointer; font-size: 13px; font-weight: 600; }
.mobile-order-profit__versions :deep(.profit-calculation-versions) { max-width: 100%; overflow-x: auto; }
.mobile-order-profit__versions :deep(.el-descriptions) { min-width: 340px; }
</style>

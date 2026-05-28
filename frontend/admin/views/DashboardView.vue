<script setup>
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  Boxes,
  BrainCircuit,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  Flame,
  ImageUp,
  PackageCheck,
  RefreshCw,
  Sparkles,
  Target,
  WandSparkles,
  Zap
} from "lucide-vue-next";
import { apiClient } from "../utils/api";

const router = useRouter();
const loading = ref(false);
const dashboard = ref({
  summary: {},
  commerce: {
    today: {},
    yesterday: {},
    advertising: { today: {}, yesterday: {} }
  },
  alerts: {
    fbp: [],
    fbs: [],
    procurement: []
  }
});

const summary = computed(() => dashboard.value.summary || {});
const commerce = computed(() => dashboard.value.commerce || {});
const today = computed(() => commerce.value.today || {});
const yesterday = computed(() => commerce.value.yesterday || {});
const adToday = computed(() => commerce.value.advertising?.today || {});
const adYesterday = computed(() => commerce.value.advertising?.yesterday || {});
const fbpAlerts = computed(() => Array.isArray(dashboard.value.alerts?.fbp) ? dashboard.value.alerts.fbp : []);
const procurementRows = computed(() => Array.isArray(dashboard.value.alerts?.procurement) ? dashboard.value.alerts.procurement : []);

const urgentCount = computed(() => Number(summary.value.urgent_count || 0));
const stockWarningCount = computed(() => Number(summary.value.warning_count || 0));
const procurementCount = computed(() => Number(summary.value.procurement_count || 0));
const todayProfitValue = computed(() => Number(today.value.profit || 0));

function numberText(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(Number(value || 0)));
}

function moneyText(value) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function decimalText(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function percentText(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function delta(current, previous) {
  const now = Number(current || 0);
  const before = Number(previous || 0);
  if (!before && !now) return { text: "持平", direction: "flat" };
  if (!before) return { text: "+100%", direction: "up" };
  const rate = (now - before) / Math.abs(before);
  return {
    text: `${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(1)}%`,
    direction: rate >= 0 ? "up" : "down"
  };
}

function open(path, query = {}) {
  router.push({ path, query });
}

const firstStockAlert = computed(() => fbpAlerts.value[0] || {});
const firstProcurement = computed(() => procurementRows.value[0] || {});
const salesDelta = computed(() => delta(today.value.revenue, yesterday.value.revenue));
const roiDelta = computed(() => delta(adToday.value.roi, adYesterday.value.roi));

const healthTone = computed(() => {
  if (todayProfitValue.value < 0) return "danger";
  if (urgentCount.value || Number(adToday.value.roi || 0) < 1) return "warning";
  return "success";
});

const aiPriority = computed(() => {
  const parts = [];
  if (Number(adToday.value.spend_cny || 0) > Number(adToday.value.revenue_cny || 0)) parts.push("广告亏损");
  if (stockWarningCount.value > 0) parts.push("库存不足");
  if (Number(adToday.value.impressions || 0) && Number(adToday.value.ctr || 0) < 0.01) parts.push("CTR下降");
  if (!parts.length) return "放大高ROI商品";
  return parts.slice(0, 2).join(" + ");
});

const supportMetrics = computed(() => [
  { label: "利润", value: `¥ ${moneyText(today.value.profit)}`, delta: delta(today.value.profit, yesterday.value.profit), icon: CircleDollarSign },
  { label: "广告消耗", value: `¥ ${moneyText(adToday.value.spend_cny)}`, delta: delta(adToday.value.spend_cny, adYesterday.value.spend_cny), icon: Target },
  { label: "订单", value: `${numberText(today.value.order_count)} 单`, delta: delta(today.value.order_count, yesterday.value.order_count), icon: ClipboardList },
  { label: "待回款", value: `¥ ${moneyText(today.value.pending_profit)}`, delta: delta(today.value.pending_profit, yesterday.value.pending_profit), icon: PackageCheck }
]);

const trendSignals = computed(() => [
  { label: "销售趋势", value: `¥ ${moneyText(today.value.revenue)}`, width: Math.min(100, Math.max(16, Number(today.value.revenue || 0) / 800)), tone: "blue" },
  { label: "ROI趋势", value: decimalText(adToday.value.roi), width: Math.min(100, Math.max(16, Number(adToday.value.roi || 0) * 22)), tone: "green" },
  { label: "CTR趋势", value: percentText(adToday.value.ctr), width: Math.min(100, Math.max(16, Number(adToday.value.ctr || 0) * 2400)), tone: "yellow" }
]);

const anomalyCards = computed(() => [
  {
    title: "广告亏损商品",
    count: Number(adToday.value.spend_cny || 0) > Number(adToday.value.revenue_cny || 0) ? 1 : 0,
    reason: "ROI低于安全线",
    action: "去止损",
    tone: "danger",
    icon: Target,
    path: "/advertising/daily"
  },
  {
    title: "库存不足商品",
    count: stockWarningCount.value,
    reason: "预计7天内断货",
    action: "去补货",
    tone: "warning",
    icon: Boxes,
    path: "/inventory/alerts"
  },
  {
    title: "CTR下降商品",
    count: Number(adToday.value.impressions || 0) && Number(adToday.value.ctr || 0) < 0.01 ? 1 : 0,
    reason: "点击率低于阈值",
    action: "去优化",
    tone: "amber",
    icon: AlertTriangle,
    path: "/advertising/daily"
  }
]);

const opportunityCards = computed(() => [
  {
    product: firstStockAlert.value.display_name || firstStockAlert.value.product_name || "TENET 门槛条",
    reason: Number(adToday.value.roi || 0) >= 2 ? `ROI ${decimalText(adToday.value.roi)}，具备放量基础` : "CTR高于平均，曝光不足",
    advice: "增加广告预算",
    icon: Flame,
    primary: "去放量",
    secondary: "AI优化",
    primaryPath: "/advertising/daily",
    secondaryPath: "/asset-variant-center/create"
  },
  {
    product: "高加购低成交商品",
    reason: `${numberText(adToday.value.add_to_cart)} 次加购信号`,
    advice: "补详情图",
    icon: Target,
    primary: "生成图",
    secondary: "看广告",
    primaryPath: "/tools/ecommerce-image-splitter",
    secondaryPath: "/advertising/daily"
  },
  {
    product: firstProcurement.value.product_name || "高利润补货商品",
    reason: `${procurementCount.value} 个待采购商品`,
    advice: "优先补有销量SKU",
    icon: PackageCheck,
    primary: "去采购",
    secondary: "看库存",
    primaryPath: "/purchase-list",
    secondaryPath: "/inventory/alerts"
  }
]);

const mustDoItems = computed(() => [
  { priority: "P0", title: `${stockWarningCount.value}个商品库存不足，建议今天补货`, action: "去处理", tone: stockWarningCount.value > 0 ? "danger" : "quiet", path: "/inventory/alerts" },
  { priority: "P1", title: `${Number(today.value.cancelled_orders || 0)}个退款待处理，避免影响店铺评分`, action: "去处理", tone: Number(today.value.cancelled_orders || 0) > 0 ? "warning" : "quiet", path: "/exceptions/profit" },
  { priority: "P1", title: `${Number(adToday.value.spend_cny || 0) > Number(adToday.value.revenue_cny || 0) ? 1 : 0}个广告严重亏损，建议暂停或调价`, action: "去处理", tone: Number(adToday.value.spend_cny || 0) > Number(adToday.value.revenue_cny || 0) ? "danger" : "quiet", path: "/advertising/daily" },
  { priority: "P2", title: "2个AI生成任务失败，需要重试", action: "去处理", tone: "quiet", path: "/asset-variant-center/create" },
  { priority: "P2", title: `${procurementCount.value}个待采购商品，需要合并采购`, action: "去处理", tone: procurementCount.value > 0 ? "warning" : "quiet", path: "/purchase-list" },
  { priority: "P2", title: `${stockWarningCount.value}个库存数据建议同步`, action: "去处理", tone: "quiet", path: "/inventory/alerts" }
]);

const riskCards = computed(() => [
  { label: "库存预警数量", value: stockWarningCount.value, unit: "个", note: "影响履约", tone: "danger", path: "/inventory/alerts" },
  { label: "断货风险", value: urgentCount.value, unit: "个", note: "优先补货", tone: "danger", path: "/inventory/alerts" },
  { label: "待采购金额", value: Number(summary.value.procurement_amount || 0), unit: "CNY", note: "现金流占用", tone: "warning", path: "/purchase-list", money: true },
  { label: "FBO/FBS异常", value: Number(summary.value.fbp_count || 0) + Number(summary.value.fbs_count || 0), unit: "个", note: "平台库存差异", tone: "blue", path: "/inventory/fbp" }
]);

const cashRiskTips = computed(() => [
  Number(adToday.value.spend_cny || 0) > Number(adYesterday.value.spend_cny || 0) * 1.3 ? "广告消耗超过昨日30%，建议复核预算。" : "广告消耗未出现明显失控。",
  Number(summary.value.procurement_amount || 0) > 0 ? "待采购金额会占用现金流，建议优先采购高周转SKU。" : "当前无明显采购资金压力。"
]);

const aiTasks = computed(() => [
  {
    type: "主图优化",
    title: firstStockAlert.value.display_name || firstStockAlert.value.product_name || "TENET T4 门槛条",
    issue: "CTR下降18%",
    advice: "型号强化 + 高点击构图",
    estimate: "CTR提升15%-30%",
    icon: ImageUp,
    path: "/asset-variant-center/create"
  },
  {
    type: "标题优化",
    title: "BELGEE X70 钥匙壳",
    issue: "曝光低",
    advice: "扩展型号词 + Ozon标签优化",
    estimate: "曝光提升10%-25%",
    icon: WandSparkles,
    path: "/listing-automation"
  },
  {
    type: "详情图优化",
    title: "防蚊网商品",
    issue: "加购高但成交低",
    advice: "补安装图 + 使用效果图",
    estimate: "转化提升8%-18%",
    icon: Sparkles,
    path: "/tools/ecommerce-image-splitter"
  }
]);

async function loadDashboard() {
  loading.value = true;
  try {
    dashboard.value = await apiClient.get("/api/dashboard");
  } catch (error) {
    ElMessage.error(error.message || "AI运营驾驶舱加载失败");
  } finally {
    loading.value = false;
  }
}

onMounted(loadDashboard);
</script>

<template>
  <div class="ai-dashboard-page">
    <section class="hero-grid">
      <div class="operating-card" :class="`is-${healthTone}`">
        <div class="operating-card__top">
          <div class="ai-kicker">
            <Bot :size="16" />
            Commerce Operating Center
          </div>
          <el-button class="refresh-button" :loading="loading" @click="loadDashboard">
            <RefreshCw :size="15" />
            刷新
          </el-button>
        </div>

        <div class="operating-main">
          <div class="sales-block">
            <span>今日销售额</span>
            <strong>¥ {{ moneyText(today.revenue) }}</strong>
            <em :class="`trend-${salesDelta.direction}`">
              <ArrowUpRight v-if="salesDelta.direction === 'up'" :size="16" />
              <ArrowDownRight v-else-if="salesDelta.direction === 'down'" :size="16" />
              今日 vs 昨日 {{ salesDelta.text }}
            </em>
          </div>

          <div class="trend-block">
            <div class="mini-bars" aria-hidden="true">
              <i></i><i></i><i></i><i></i><i></i><i></i>
            </div>
            <article v-for="item in trendSignals" :key="item.label">
              <div>
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
              </div>
              <div class="track"><b :class="`tone-${item.tone}`" :style="{ width: `${item.width}%` }"></b></div>
            </article>
          </div>

          <div class="roi-block">
            <span>ROI</span>
            <strong>{{ decimalText(adToday.roi) }}</strong>
            <em :class="`trend-${roiDelta.direction}`">{{ roiDelta.text }}</em>
          </div>
        </div>

        <div class="metric-row">
          <article v-for="item in supportMetrics" :key="item.label">
            <component :is="item.icon" :size="16" />
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
        </div>

        <div class="ai-hint">
          <Zap :size="16" />
          <span>今日优先处理：{{ aiPriority }}</span>
        </div>
      </div>

      <aside class="hero-rail">
        <section class="rail-card">
          <div class="rail-head">
            <div>
              <span>AI异常 TOP 3</span>
              <h2>立刻处理</h2>
            </div>
            <AlertTriangle :size="20" />
          </div>
          <article v-for="item in anomalyCards" :key="item.title" class="rail-item" :class="`is-${item.tone}`">
            <component :is="item.icon" :size="17" />
            <div>
              <strong>{{ item.title }}</strong>
              <span>{{ item.count }}个，{{ item.reason }}</span>
            </div>
            <el-button size="small" @click="open(item.path)">{{ item.action }}</el-button>
          </article>
        </section>

        <section class="rail-card">
          <div class="rail-head">
            <div>
              <span>AI机会 TOP 3</span>
              <h2>可以放大</h2>
            </div>
            <Flame :size="20" />
          </div>
          <article v-for="item in opportunityCards" :key="item.product" class="opportunity-item">
            <component :is="item.icon" :size="17" />
            <div>
              <strong>{{ item.product }}</strong>
              <span>{{ item.reason }}</span>
              <em>建议：{{ item.advice }}</em>
            </div>
            <div class="item-actions">
              <el-button type="primary" size="small" @click="open(item.primaryPath)">{{ item.primary }}</el-button>
              <el-button size="small" @click="open(item.secondaryPath)">{{ item.secondary }}</el-button>
            </div>
          </article>
        </section>
      </aside>
    </section>

    <section class="ops-grid">
      <div class="panel must-panel">
        <div class="section-title">
          <div>
            <span>今日待办</span>
            <h2>必须处理清单</h2>
          </div>
          <ClipboardList :size="22" />
        </div>
        <div class="must-list">
          <article v-for="item in mustDoItems" :key="item.title" class="must-item" :class="`is-${item.tone}`">
            <span>{{ item.priority }}</span>
            <strong>{{ item.title }}</strong>
            <el-button size="small" @click="open(item.path)">{{ item.action }}</el-button>
          </article>
        </div>
      </div>

      <div class="panel risk-panel">
        <div class="section-title">
          <div>
            <span>库存与资金风险</span>
            <h2>库存和现金流</h2>
          </div>
          <Boxes :size="22" />
        </div>
        <div class="risk-grid">
          <button v-for="item in riskCards" :key="item.label" type="button" class="risk-card" :class="`is-${item.tone}`" @click="open(item.path)">
            <span>{{ item.label }}</span>
            <strong>{{ item.money ? moneyText(item.value) : numberText(item.value) }}<small>{{ item.unit }}</small></strong>
            <em>{{ item.note }}</em>
          </button>
        </div>
        <div class="cash-tips">
          <p v-for="tip in cashRiskTips" :key="tip">{{ tip }}</p>
        </div>
      </div>
    </section>

    <section class="panel ai-queue">
      <div class="section-title">
        <div>
          <span>AI任务队列</span>
          <h2>需要AI辅助的优化</h2>
        </div>
        <BrainCircuit :size="22" />
      </div>
      <div class="queue-list">
        <article v-for="task in aiTasks" :key="task.type" class="queue-item">
          <div class="queue-icon">
            <component :is="task.icon" :size="18" />
          </div>
          <div class="queue-main">
            <span>{{ task.type }}</span>
            <strong>{{ task.title }}</strong>
            <p>{{ task.issue }}，建议：{{ task.advice }}</p>
          </div>
          <em>{{ task.estimate }}</em>
          <el-button type="primary" size="small" @click="open(task.path)">立即优化</el-button>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ai-dashboard-page {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding-bottom: 22px;
  color: var(--erp-text);
}

.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.72fr) minmax(360px, 0.86fr);
  gap: 18px;
}

.operating-card {
  position: relative;
  min-height: 610px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  overflow: hidden;
  padding: 30px;
  border-radius: 28px;
  color: #eef6ff;
  background:
    radial-gradient(circle at 15% 6%, rgba(37, 99, 235, 0.34), transparent 30%),
    radial-gradient(circle at 82% 20%, rgba(20, 184, 166, 0.18), transparent 25%),
    linear-gradient(145deg, #06101f 0%, #0b1728 50%, #111827 100%);
  box-shadow: 0 28px 76px rgba(2, 6, 23, 0.26);
}

.operating-card.is-danger {
  background:
    radial-gradient(circle at 15% 6%, rgba(220, 38, 38, 0.24), transparent 30%),
    radial-gradient(circle at 82% 20%, rgba(37, 99, 235, 0.18), transparent 25%),
    linear-gradient(145deg, #120b12 0%, #0b1728 50%, #111827 100%);
}

.operating-card.is-warning {
  background:
    radial-gradient(circle at 15% 6%, rgba(217, 119, 6, 0.26), transparent 30%),
    radial-gradient(circle at 82% 20%, rgba(37, 99, 235, 0.18), transparent 25%),
    linear-gradient(145deg, #111827 0%, #0b1728 50%, #06101f 100%);
}

.operating-card::after {
  content: "";
  position: absolute;
  right: 28px;
  bottom: 34px;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(96, 165, 250, 0.12), transparent 68%);
  pointer-events: none;
}

.operating-card__top,
.operating-main,
.metric-row,
.section-title,
.rail-head {
  position: relative;
  z-index: 1;
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.operating-card__top,
.section-title,
.rail-head {
  align-items: flex-start;
}

.ai-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: #bfdbfe;
  font-size: 13px;
  font-weight: 700;
}

.refresh-button {
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
  color: #e2e8f0;
}

.operating-main {
  align-items: stretch;
  margin-top: 12px;
}

.sales-block {
  flex: 1.08;
  min-width: 0;
}

.sales-block span,
.roi-block span,
.metric-row span,
.trend-block span {
  color: #a8b7cc;
}

.sales-block span {
  display: block;
  margin-bottom: 12px;
  font-size: 15px;
  font-weight: 700;
}

.sales-block strong {
  display: block;
  color: #fff;
  font-size: 74px;
  line-height: 0.98;
}

.sales-block em,
.roi-block em {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 14px;
  font-size: 13px;
  font-style: normal;
  font-weight: 700;
}

.trend-block {
  flex: 0.9;
  display: grid;
  gap: 12px;
  padding: 18px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.mini-bars {
  display: flex;
  align-items: end;
  gap: 8px;
  height: 72px;
}

.mini-bars i {
  flex: 1;
  border-radius: 999px 999px 0 0;
  background: linear-gradient(180deg, rgba(96, 165, 250, 0.92), rgba(96, 165, 250, 0.12));
}

.mini-bars i:nth-child(1) { height: 34%; }
.mini-bars i:nth-child(2) { height: 52%; }
.mini-bars i:nth-child(3) { height: 44%; }
.mini-bars i:nth-child(4) { height: 68%; }
.mini-bars i:nth-child(5) { height: 58%; }
.mini-bars i:nth-child(6) { height: 82%; }

.trend-block article {
  display: grid;
  gap: 7px;
}

.trend-block article > div:first-child {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}

.trend-block strong {
  color: #f8fafc;
  font-size: 12px;
}

.track {
  height: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.22);
}

.track b {
  display: block;
  height: 100%;
  border-radius: inherit;
}

.tone-blue { background: #60a5fa; }
.tone-green { background: #34d399; }
.tone-yellow { background: #f59e0b; }

.roi-block {
  width: 170px;
  display: grid;
  align-content: start;
  gap: 6px;
  padding: 20px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.13);
}

.roi-block strong {
  color: #fff;
  font-size: 44px;
  line-height: 1;
}

.metric-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.metric-row article {
  display: grid;
  gap: 8px;
  min-height: 104px;
  padding: 15px;
  border-radius: 18px;
  background: rgba(15, 23, 42, 0.56);
  border: 1px solid rgba(148, 163, 184, 0.14);
}

.metric-row svg {
  color: #93c5fd;
}

.metric-row strong {
  color: #f8fafc;
  font-size: 19px;
  line-height: 1.12;
}

.ai-hint {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: auto;
  padding: 14px 16px;
  border-radius: 18px;
  background: rgba(15, 23, 42, 0.66);
  border: 1px solid rgba(148, 163, 184, 0.14);
  color: #f8fafc;
  font-weight: 800;
}

.ai-hint svg {
  color: #facc15;
}

.hero-rail {
  display: grid;
  grid-template-rows: minmax(0, 0.92fr) minmax(0, 1.08fr);
  gap: 18px;
}

.rail-card,
.panel {
  padding: 22px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 18px 44px rgba(15, 23, 42, 0.07);
}

.rail-card {
  overflow: hidden;
}

.rail-head,
.section-title {
  margin-bottom: 16px;
}

.rail-head span,
.section-title span,
.rail-item span,
.opportunity-item span,
.risk-card span,
.queue-main span {
  color: var(--erp-text-secondary);
}

.rail-head h2,
.section-title h2 {
  margin: 5px 0 0;
  font-size: 21px;
  line-height: 1.2;
}

.rail-item,
.opportunity-item {
  display: grid;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 18px;
  background: #f8fafc;
}

.rail-item + .rail-item,
.opportunity-item + .opportunity-item {
  margin-top: 10px;
}

.rail-item {
  grid-template-columns: 28px 1fr auto;
}

.rail-item strong,
.opportunity-item strong {
  display: block;
  color: var(--erp-text);
  font-size: 14px;
}

.rail-item span,
.opportunity-item span,
.opportunity-item em {
  display: block;
  margin-top: 3px;
  font-size: 12px;
}

.rail-item.is-danger { background: #fff1f2; }
.rail-item.is-warning,
.rail-item.is-amber { background: #fffbeb; }
.rail-item.is-danger svg { color: #dc2626; }
.rail-item.is-warning svg,
.rail-item.is-amber svg { color: #d97706; }

.opportunity-item {
  grid-template-columns: 28px 1fr;
}

.opportunity-item svg {
  color: #ef4444;
}

.opportunity-item em {
  color: #0f766e;
  font-style: normal;
  font-weight: 700;
}

.item-actions {
  grid-column: 2;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.ops-grid {
  display: grid;
  grid-template-columns: 1.1fr 0.9fr;
  gap: 18px;
}

.must-list {
  display: grid;
  gap: 10px;
}

.must-item {
  display: grid;
  grid-template-columns: 54px 1fr auto;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  padding: 12px 14px;
  border-radius: 18px;
  background: #f8fafc;
}

.must-item > span {
  width: 38px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: #e2e8f0;
  color: #334155;
  font-size: 12px;
  font-weight: 800;
}

.must-item strong {
  font-size: 15px;
}

.must-item.is-danger { background: #fff1f2; }
.must-item.is-warning { background: #fffbeb; }
.must-item.is-danger > span { background: #fee2e2; color: #dc2626; }
.must-item.is-warning > span { background: #fef3c7; color: #d97706; }

.risk-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.risk-card {
  display: grid;
  gap: 8px;
  min-height: 112px;
  padding: 15px;
  border: 0;
  border-radius: 18px;
  background: #f8fafc;
  text-align: left;
  cursor: pointer;
}

.risk-card strong {
  font-size: 28px;
  line-height: 1;
}

.risk-card small {
  margin-left: 5px;
  color: var(--erp-text-secondary);
  font-size: 12px;
}

.risk-card em {
  color: var(--erp-text-secondary);
  font-size: 12px;
  font-style: normal;
}

.risk-card.is-danger strong { color: #dc2626; }
.risk-card.is-warning strong { color: #d97706; }
.risk-card.is-blue strong { color: #2563eb; }

.cash-tips {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.cash-tips p {
  margin: 0;
  padding: 10px 12px;
  border-radius: 14px;
  background: #f8fafc;
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.queue-list {
  display: grid;
  gap: 10px;
}

.queue-item {
  display: grid;
  grid-template-columns: 42px 1fr auto auto;
  align-items: center;
  gap: 12px;
  min-height: 112px;
  padding: 14px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(37, 99, 235, 0.06), rgba(248, 250, 252, 0.96));
}

.queue-icon {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  background: #0f172a;
  color: #bfdbfe;
}

.queue-main {
  min-width: 0;
}

.queue-main span {
  display: block;
  font-size: 12px;
  font-weight: 800;
}

.queue-main strong {
  display: block;
  margin-top: 3px;
  font-size: 16px;
}

.queue-main p {
  margin: 4px 0 0;
  color: var(--erp-text-secondary);
  font-size: 13px;
}

.queue-item > em {
  color: #047857;
  font-size: 13px;
  font-style: normal;
  font-weight: 800;
  white-space: nowrap;
}

.trend-up { color: #34d399; }
.trend-down { color: #fb7185; }
.trend-flat { color: #94a3b8; }

:deep(.el-button svg) {
  margin-right: 6px;
}

@media (max-width: 1500px) {
  .hero-grid,
  .ops-grid {
    grid-template-columns: 1fr;
  }

  .hero-rail {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: none;
  }
}

@media (max-width: 1080px) {
  .operating-main,
  .hero-rail,
  .metric-row,
  .queue-item {
    grid-template-columns: 1fr;
    display: grid;
  }

  .roi-block {
    width: auto;
  }
}

@media (max-width: 720px) {
  .operating-card {
    min-height: 0;
    padding: 22px;
  }

  .sales-block strong {
    font-size: 46px;
  }

  .rail-item,
  .must-item,
  .risk-grid {
    grid-template-columns: 1fr;
  }
}
</style>

<script setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";
import { ArrowLeftRight } from "lucide-vue-next";
import { apiClient, currentApiCacheScope } from "../utils/api.js";
import { shanghaiDateKey, shanghaiDateText } from "../utils/shanghai-date.js";
import { requestExchangeRateDialog } from "../utils/exchange-rate-dialog.js";

const today = ref(null);
const loading = ref(false);
const failed = ref(false);
let controller, timer, sequence = 0;
const value = computed(() => today.value?.available && Number(today.value.rate) > 0 ? Number(today.value.rate).toFixed(4) : loading.value ? "读取中" : "待更新");
const dateText = computed(() => shanghaiDateText(`${today.value?.business_date || shanghaiDateKey()}T00:00:00+08:00`));
const hint = computed(() => failed.value ? "暂未读到今日档案，点击查看" : "1 人民币可兑换的卢布数");

async function loadToday() {
  controller?.abort();
  const ownController = new AbortController();
  controller = ownController;
  const ownSequence = ++sequence, scope = currentApiCacheScope();
  loading.value = true;
  failed.value = false;
  try {
    const data = await apiClient.get("/api/exchange-rates/tool/today", { signal: ownController.signal, routeScoped: false });
    if (ownSequence !== sequence || scope !== currentApiCacheScope() || ownController.signal.aborted) return;
    today.value = data?.public?.today || null;
  } catch {
    if (ownSequence !== sequence || ownController.signal.aborted) return;
    today.value = null;
    failed.value = true;
  } finally {
    if (ownSequence === sequence) loading.value = false;
  }
}
function resetScope() {
  sequence++;
  controller?.abort();
  today.value = null;
  if (timer) loadToday();
}
function start() {
  if (timer) return;
  loadToday();
  timer = window.setInterval(() => {
    if (document.visibilityState !== "hidden" && (!today.value?.available || today.value.business_date !== shanghaiDateKey())) loadToday();
  }, 60000);
  window.addEventListener("erp:auth-scope-changed", resetScope);
}
function stop() {
  window.clearInterval(timer);
  timer = null;
  sequence++;
  controller?.abort();
  loading.value = false;
  window.removeEventListener("erp:auth-scope-changed", resetScope);
}
onMounted(start);
onActivated(start);
onDeactivated(stop);
onBeforeUnmount(stop);
</script>

<template>
  <button type="button" class="primary-metric daily-exchange-rate-card" aria-label="每日汇率，打开汇率工具" @click="requestExchangeRateDialog">
    <div class="metric-label"><ArrowLeftRight :size="16" />每日汇率</div>
    <strong>{{ value }}</strong>
    <div class="metric-subline"><span>{{ hint }}</span></div>
    <div class="metric-footer"><span>{{ dateText }}</span><em>查看曲线</em></div>
  </button>
</template>

<style scoped>
.daily-exchange-rate-card { display: flex; flex-direction: column; width: 100%; text-align: left; font: inherit; cursor: pointer; color: var(--erp-text-main); }
.daily-exchange-rate-card .metric-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--dashboard-theme-text-secondary, var(--erp-text-secondary)); }
.daily-exchange-rate-card strong { display: block; margin: 12px 0 8px; line-height: 1.2; font-variant-numeric: tabular-nums; color: var(--dashboard-theme-primary, var(--erp-primary)) !important; font-size: clamp(21px, 1.9vw, 30px) !important; }
.daily-exchange-rate-card .metric-subline { line-height: 1.5; font-size: 11px; }
.daily-exchange-rate-card .metric-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; margin-top: auto; padding-top: 10px; font-size: 10px; color: var(--dashboard-theme-text-secondary, var(--erp-text-secondary)); }
.daily-exchange-rate-card .metric-footer em { font-style: normal; color: var(--dashboard-theme-primary, var(--erp-primary)); }
.daily-exchange-rate-card:focus-visible { outline: 2px solid var(--erp-primary); outline-offset: 2px; }
</style>

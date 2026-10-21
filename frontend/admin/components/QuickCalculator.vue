<script setup>
import { nextTick, ref } from "vue";
import { calculateExpression } from "../utils/quick-calculator.js";

const expression = ref("");
const result = ref("");
const error = ref("");
const input = ref(null);
const keys = ["C", "(", ")", "⌫", "7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "%", "+"];
function calculate() {
  try { result.value = calculateExpression(expression.value); error.value = ""; }
  catch (failure) { error.value = failure.message; result.value = ""; }
}
function press(key) {
  error.value = "";
  if (key !== "=") result.value = "";
  if (key === "C") { expression.value = ""; result.value = ""; }
  else if (key === "⌫") expression.value = expression.value.slice(0, -1);
  else if (key === "=") calculate();
  else expression.value = (expression.value + key).slice(0, 256);
  nextTick(() => input.value?.focus());
}
function onKey(event) {
  if (event.key === "Enter" || event.key === "=") { event.preventDefault(); calculate(); }
}
</script>

<template>
  <section class="quick-calculator" @keydown="onKey">
    <p>输入算式快速算账，例如 20 × 18.5 + 12。百分号将数字除以 100。</p>
    <el-input ref="input" v-model="expression" aria-label="计算算式" placeholder="20 × 18.5 + 12" maxlength="256" clearable @input="error = ''; result = ''" />
    <output class="quick-calculator__result" aria-live="polite">{{ error || (result ? `= ${result}` : '等待计算') }}</output>
    <div class="quick-calculator__keys">
      <button v-for="key in keys" :key="key" type="button" :aria-label="key === '⌫' ? '退格' : key === 'C' ? '清空算式' : key" @click="press(key)">{{ key }}</button>
    </div>
    <el-button type="primary" class="quick-calculator__equals" @click="calculate">计算结果 <span>Enter</span></el-button>
    <el-button v-if="result" text class="quick-calculator__reuse" @click="expression = result; result = ''">用结果继续计算</el-button>
  </section>
</template>

<style scoped>
.quick-calculator { display: grid; gap: 14px; color: var(--erp-text-main); }
.quick-calculator p { margin: 0; font-size: 12px; line-height: 1.7; color: var(--erp-text-regular); }
.quick-calculator :deep(input) { font-size: 20px; font-variant-numeric: tabular-nums; }
.quick-calculator__result { min-height: 42px; text-align: right; overflow-wrap: anywhere; font-size: 22px; font-variant-numeric: tabular-nums; color: var(--erp-primary); }
.quick-calculator__keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.quick-calculator__keys button { min-height: 48px; border: 1px solid var(--erp-border); border-radius: 8px; background: var(--erp-surface-alt); color: var(--erp-text-main); font: inherit; font-size: 18px; cursor: pointer; }
.quick-calculator__keys button:hover { background: var(--erp-primary-soft); border-color: var(--erp-primary); }
.quick-calculator__keys button:focus-visible { outline: 2px solid var(--erp-primary); outline-offset: 2px; }
.quick-calculator__equals { margin: 0; min-height: 42px; }
.quick-calculator__equals span { margin-left: 12px; font-size: 11px; opacity: .8; }
.quick-calculator__reuse { margin: 0; }
</style>

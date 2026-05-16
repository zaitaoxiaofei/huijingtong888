<script setup>
import { reactive, watch } from "vue";

const props = defineProps({
  model: {
    type: Object,
    default: () => ({
      logisticsForm: {},
      logisticsRows: [],
      cancellationForm: {},
      cancellationRows: [],
      testerForm: {},
      testerResult: null
    })
  }
});

const emit = defineEmits([
  "save-logistics",
  "reset-logistics",
  "edit-logistics",
  "delete-logistics",
  "save-cancellation",
  "reset-cancellation",
  "edit-cancellation",
  "delete-cancellation",
  "test-cancellation",
  "reset-tester"
]);

const logisticsForm = reactive({});
const cancellationForm = reactive({});
const testerForm = reactive({});

watch(
  () => props.model,
  (next) => {
    Object.keys(logisticsForm).forEach((key) => delete logisticsForm[key]);
    Object.keys(cancellationForm).forEach((key) => delete cancellationForm[key]);
    Object.keys(testerForm).forEach((key) => delete testerForm[key]);
    Object.assign(logisticsForm, next?.logisticsForm || {});
    Object.assign(cancellationForm, next?.cancellationForm || {});
    Object.assign(testerForm, next?.testerForm || {});
  },
  { immediate: true, deep: true }
);

function submitLogistics() {
  emit("save-logistics", { ...logisticsForm });
}

function submitCancellation() {
  emit("save-cancellation", { ...cancellationForm });
}

function submitTester() {
  emit("test-cancellation", { ...testerForm });
}
</script>

<template>
  <section class="vue-config-logistics-grid">
    <section class="vue-config-logistics-forms">
      <section class="ds-card">
        <div class="ds-card-header">
          <div>
            <h2>物流运费规则</h2>
          </div>
        </div>
        <div class="ds-card-body">
          <form class="vue-config-logistics-fields" @submit.prevent="submitLogistics">
            <label class="ds-field"><span>规则名称</span><input v-model="logisticsForm.name" class="ds-input" required /></label>
            <label class="ds-field"><span>物流商</span><input v-model="logisticsForm.carrier" class="ds-input" /></label>
            <label class="ds-field"><span>渠道</span><input v-model="logisticsForm.channel" class="ds-input" /></label>
            <label class="ds-field"><span>计费模式</span><select v-model="logisticsForm.mode" class="ds-select"><option value="per_gram">按克重</option><option value="fixed">固定费用</option></select></label>
            <label class="ds-field"><span>最小克重</span><input v-model="logisticsForm.min_weight_g" class="ds-input" type="number" step="1" /></label>
            <label class="ds-field"><span>最大克重</span><input v-model="logisticsForm.max_weight_g" class="ds-input" type="number" step="1" /></label>
            <label class="ds-field"><span>最低售价(RUB)</span><input v-model="logisticsForm.min_price_rub" class="ds-input" type="number" step="1" /></label>
            <label class="ds-field"><span>最高售价(RUB)</span><input v-model="logisticsForm.max_price_rub" class="ds-input" type="number" step="1" /></label>
            <label class="ds-field"><span>基础费用(RMB)</span><input v-model="logisticsForm.base_fee_cny" class="ds-input" type="number" step="0.001" /></label>
            <label class="ds-field"><span>每克费用(RMB)</span><input v-model="logisticsForm.per_gram_cny" class="ds-input" type="number" step="0.0001" /></label>
            <label class="ds-field"><span>每票费用(RMB)</span><input v-model="logisticsForm.per_ticket_cny" class="ds-input" type="number" step="0.001" /></label>
            <label class="ds-field"><span>状态</span><select v-model="logisticsForm.enabled" class="ds-select"><option value="1">启用</option><option value="0">停用</option></select></label>
            <label class="ds-field full"><span>备注</span><input v-model="logisticsForm.note" class="ds-input" /></label>
            <div class="edit-actions full">
              <button type="button" class="ds-btn" @click="emit('reset-logistics')">重置</button>
              <button type="submit" class="ds-btn ds-btn-primary">保存物流规则</button>
            </div>
          </form>
        </div>
      </section>

      <section class="ds-card">
        <div class="ds-card-header">
          <div>
            <h2>取消/退货原因规则</h2>
          </div>
        </div>
        <div class="ds-card-body">
          <form class="vue-config-logistics-fields" @submit.prevent="submitCancellation">
            <label class="ds-field"><span>规则名称</span><input v-model="cancellationForm.name" class="ds-input" required /></label>
            <label class="ds-field"><span>匹配文本</span><input v-model="cancellationForm.match_text" class="ds-input" required /></label>
            <label class="ds-field"><span>匹配模式</span><select v-model="cancellationForm.match_mode" class="ds-select"><option value="contains">包含</option><option value="equals">完全等于</option><option value="starts_with">前缀匹配</option><option value="regex">正则</option></select></label>
            <label class="ds-field"><span>取消方标签</span><input v-model="cancellationForm.initiator_label" class="ds-input" /></label>
            <label class="ds-field"><span>原因标签</span><input v-model="cancellationForm.reason_label" class="ds-input" /></label>
            <label class="ds-field"><span>原因编码</span><input v-model="cancellationForm.reason_code" class="ds-input" /></label>
            <label class="ds-field"><span>原因分组</span><input v-model="cancellationForm.reason_group_label" class="ds-input" /></label>
            <label class="ds-field"><span>优先级</span><input v-model="cancellationForm.priority" class="ds-input" type="number" step="1" /></label>
            <label class="ds-field"><span>状态</span><select v-model="cancellationForm.enabled" class="ds-select"><option value="1">启用</option><option value="0">停用</option></select></label>
            <label class="ds-field full"><span>口径说明</span><input v-model="cancellationForm.accounting_hint" class="ds-input" /></label>
            <label class="ds-field full"><span>备注</span><input v-model="cancellationForm.note" class="ds-input" /></label>
            <div class="edit-actions full">
              <button type="button" class="ds-btn" @click="emit('reset-cancellation')">重置</button>
              <button type="submit" class="ds-btn ds-btn-primary">保存规则</button>
            </div>
          </form>
        </div>
      </section>
    </section>

    <section class="ds-card">
      <div class="ds-card-header">
        <div>
          <h2>规则测试器</h2>
        </div>
      </div>
      <div class="ds-card-body">
        <form class="vue-config-logistics-fields" @submit.prevent="submitTester">
          <label class="ds-field"><span>原始原因</span><input v-model="testerForm.cancel_reason" class="ds-input" /></label>
          <label class="ds-field"><span>取消方</span><input v-model="testerForm.cancel_initiator" class="ds-input" /></label>
          <label class="ds-field"><span>取消类型</span><input v-model="testerForm.cancel_type" class="ds-input" /></label>
          <label class="ds-field"><span>订单状态</span><input v-model="testerForm.status" class="ds-input" /></label>
          <label class="ds-field"><span>物流阶段</span><input v-model="testerForm.tracking_stage" class="ds-input" /></label>
          <label class="ds-field"><span>已发货标记</span><select v-model="testerForm.cancelled_after_ship" class="ds-select"><option value="0">否</option><option value="1">是</option></select></label>
          <label class="ds-field full"><span>原始取消原因补充</span><input v-model="testerForm.raw_cancellation_reason" class="ds-input" /></label>
          <div class="edit-actions full">
            <button type="button" class="ds-btn" @click="emit('reset-tester')">清空</button>
            <button type="submit" class="ds-btn ds-btn-primary">测试规则</button>
          </div>
        </form>
        <div v-if="model.testerResult" class="vue-config-tester-result">
          <div><strong>订单结果类型：</strong>{{ model.testerResult.outcome_type_text || "-" }}</div>
          <div><strong>命中规则：</strong>{{ model.testerResult.matched_rule_text || "未命中配置规则，使用默认兜底判断" }}</div>
          <div><strong>取消方标签：</strong>{{ model.testerResult.initiator_label || "-" }}</div>
          <div><strong>原因标签：</strong>{{ model.testerResult.reason_label || "-" }}</div>
          <div><strong>原因分组：</strong>{{ model.testerResult.reason_group_text || "-" }}</div>
          <div><strong>会计口径：</strong>{{ model.testerResult.accounting_hint || "-" }}</div>
        </div>
      </div>
    </section>

    <section class="ds-card vue-config-table-card">
      <div class="ds-card-header">
        <div>
          <h2>物流规则列表</h2>
        </div>
      </div>
      <div v-if="!model.logisticsRows?.length" class="ds-empty vue-config-empty">当前没有物流规则。</div>
      <div v-else class="ds-table-wrap">
        <table class="ds-table vue-config-table">
          <thead>
            <tr>
              <th>规则</th>
              <th>匹配范围</th>
              <th>费用</th>
              <th>状态</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in model.logisticsRows" :key="row.id">
              <td>
                <strong>{{ row.name }}</strong>
                <div class="vue-config-cell-meta">{{ row.carrier }} / {{ row.channel }} / {{ row.mode_label }}</div>
              </td>
              <td>
                <div>克重 {{ row.weight_range_text }}</div>
                <div class="vue-config-cell-meta">售价 {{ row.price_range_text }}</div>
              </td>
              <td>
                <strong>{{ row.fee_total_text }}</strong>
                <div class="vue-config-cell-meta">每克 {{ row.per_gram_text }}</div>
              </td>
              <td><span class="ds-badge" :class="row.enabled ? 'ds-badge-success' : 'ds-badge-warning'">{{ row.enabled ? "启用" : "停用" }}</span></td>
              <td>{{ row.note || "-" }}</td>
              <td>
                <div class="vue-config-row-actions">
                  <button type="button" class="ds-btn ds-btn-ghost ds-btn-small" @click="emit('edit-logistics', row.id)">编辑</button>
                  <button type="button" class="ds-btn ds-btn-danger ds-btn-small" @click="emit('delete-logistics', row.id)">停用</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="ds-card vue-config-table-card">
      <div class="ds-card-header">
        <div>
          <h2>取消/退货规则列表</h2>
        </div>
      </div>
      <div v-if="!model.cancellationRows?.length" class="ds-empty vue-config-empty">当前没有取消/退货规则。</div>
      <div v-else class="ds-table-wrap">
        <table class="ds-table vue-config-table">
          <thead>
            <tr>
              <th>规则名称</th>
              <th>匹配文本</th>
              <th>取消方</th>
              <th>原因标签</th>
              <th>口径说明</th>
              <th>优先级</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in model.cancellationRows" :key="row.id">
              <td>
                <strong>{{ row.name || "-" }}</strong>
                <div class="vue-config-cell-meta">{{ row.reason_group_label || "-" }} / {{ row.reason_code || "-" }}</div>
              </td>
              <td>
                <div>{{ row.match_text || "-" }}</div>
                <div class="vue-config-cell-meta">{{ row.match_mode || "contains" }}</div>
              </td>
              <td>{{ row.initiator_label || "-" }}</td>
              <td>
                <div>{{ row.reason_label || "-" }}</div>
                <div class="vue-config-cell-meta">{{ row.reason_group_label || "-" }}</div>
              </td>
              <td>{{ row.accounting_hint || "-" }}</td>
              <td>
                <div>{{ row.priority || 0 }}</div>
                <div class="vue-config-cell-meta">{{ row.enabled ? "启用" : "停用" }}</div>
              </td>
              <td>
                <div class="vue-config-row-actions">
                  <button type="button" class="ds-btn ds-btn-ghost ds-btn-small" @click="emit('edit-cancellation', row.id)">编辑</button>
                  <button type="button" class="ds-btn ds-btn-danger ds-btn-small" @click="emit('delete-cancellation', row.id)">停用</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

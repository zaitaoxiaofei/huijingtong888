<script setup>
import { reactive, watch } from "vue";

const props = defineProps({
  initialForm: { type: Object, default: () => ({}) },
  result: { type: Object, default: () => ({}) }
});

const emit = defineEmits(["calculate"]);

const form = reactive({
  sale_rmb: "",
  exchange_rate: "",
  purchase_cost: "",
  domestic_shipping: "",
  purchase_quantity: "",
  return_rate: "",
  weight_kg: "",
  length_cm: "",
  width_cm: "",
  height_cm: "",
  final_mile_bank_rate: "",
  withdrawal_fee_rate: "",
  advertising_rate: ""
});

watch(
  () => props.initialForm,
  (next) => {
    Object.assign(form, {
      sale_rmb: String(next?.sale_rmb ?? ""),
      exchange_rate: String(next?.exchange_rate ?? ""),
      purchase_cost: String(next?.purchase_cost ?? ""),
      domestic_shipping: String(next?.domestic_shipping ?? ""),
      purchase_quantity: String(next?.purchase_quantity ?? ""),
      return_rate: String(next?.return_rate ?? ""),
      weight_kg: String(next?.weight_kg ?? ""),
      length_cm: String(next?.length_cm ?? ""),
      width_cm: String(next?.width_cm ?? ""),
      height_cm: String(next?.height_cm ?? ""),
      final_mile_bank_rate: String(next?.final_mile_bank_rate ?? ""),
      withdrawal_fee_rate: String(next?.withdrawal_fee_rate ?? ""),
      advertising_rate: String(next?.advertising_rate ?? "")
    });
  },
  { immediate: true, deep: true }
);

function submit() {
  emit("calculate", { ...form });
}
</script>

<template>
  <section class="vue-config-formula-grid">
    <section class="ds-card vue-config-formula-card">
      <div class="ds-card-header">
        <div>
          <h2>CEL rFBS 计价公式</h2>
        </div>
      </div>
      <div class="ds-card-body vue-config-formula-fields">
        <label class="ds-field"><span>售价(RMB)</span><input v-model="form.sale_rmb" class="ds-input" type="number" step="0.01" @input="submit" /></label>
        <label class="ds-field"><span>汇率(RMB/RUB)</span><input v-model="form.exchange_rate" class="ds-input" type="number" step="0.001" @input="submit" /></label>
        <label class="ds-field"><span>采购单价(RMB)</span><input v-model="form.purchase_cost" class="ds-input" type="number" step="0.01" @input="submit" /></label>
        <label class="ds-field"><span>国内运费(RMB)</span><input v-model="form.domestic_shipping" class="ds-input" type="number" step="0.01" @input="submit" /></label>
        <label class="ds-field"><span>采购数量</span><input v-model="form.purchase_quantity" class="ds-input" type="number" step="1" min="1" @input="submit" /></label>
        <label class="ds-field"><span>退货率</span><input v-model="form.return_rate" class="ds-input" type="number" step="0.001" @input="submit" /></label>
        <label class="ds-field"><span>实际重量(KG)</span><input v-model="form.weight_kg" class="ds-input" type="number" step="0.001" @input="submit" /></label>
        <label class="ds-field"><span>长(cm)</span><input v-model="form.length_cm" class="ds-input" type="number" step="0.1" @input="submit" /></label>
        <label class="ds-field"><span>宽(cm)</span><input v-model="form.width_cm" class="ds-input" type="number" step="0.1" @input="submit" /></label>
        <label class="ds-field"><span>高(cm)</span><input v-model="form.height_cm" class="ds-input" type="number" step="0.1" @input="submit" /></label>
        <label class="ds-field"><span>尾程+银行手续费率</span><input v-model="form.final_mile_bank_rate" class="ds-input" type="number" step="0.001" @input="submit" /></label>
        <label class="ds-field"><span>提现手续费率</span><input v-model="form.withdrawal_fee_rate" class="ds-input" type="number" step="0.001" @input="submit" /></label>
        <label class="ds-field"><span>广告预算率</span><input v-model="form.advertising_rate" class="ds-input" type="number" step="0.001" @input="submit" /></label>
      </div>
    </section>

    <section class="ds-card vue-config-formula-card">
      <div class="ds-card-header">
        <div>
          <h2>试算结果</h2>
        </div>
      </div>
      <div class="ds-card-body">
        <div v-if="result.error" class="ds-empty vue-config-empty">{{ result.error }}</div>
        <template v-else>
          <div class="vue-config-summary">
            <span v-for="item in result.metrics || []" :key="`${item.label}-${item.value}`" class="ds-badge ds-badge-info">
              {{ item.label }} {{ item.value }}
            </span>
          </div>
          <div v-if="result.channels?.length" class="ds-table-wrap">
            <table class="ds-table vue-config-table">
              <thead>
                <tr>
                  <th>渠道</th>
                  <th>时效</th>
                  <th>运费</th>
                  <th>佣金</th>
                  <th>支付费</th>
                  <th>提现费</th>
                  <th>广告</th>
                  <th>退货预损</th>
                  <th>利润</th>
                  <th>利润率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in result.channels" :key="`${row.channel}-${row.days}`">
                  <td>{{ row.channel }}</td>
                  <td>{{ row.days }}</td>
                  <td>{{ row.amount }}</td>
                  <td>{{ row.commission }}</td>
                  <td>{{ row.paymentFee }}</td>
                  <td>{{ row.withdrawalFee }}</td>
                  <td>{{ row.advertisingCost }}</td>
                  <td>{{ row.expectedReturnLoss }}</td>
                  <td>{{ row.profit }}</td>
                  <td>{{ row.margin }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else class="ds-empty vue-config-empty">当前参数下没有可显示的匹配结果。</div>
        </template>
      </div>
    </section>
  </section>
</template>

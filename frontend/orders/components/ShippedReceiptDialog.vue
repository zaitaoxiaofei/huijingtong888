<script setup>
defineProps({ shippedReceiptDialog: { type: Object, required: true } });
const emit = defineEmits(['preview', 'confirm', 'review']);
</script>
<template>
    <el-dialog v-model="shippedReceiptDialog.visible" title="核对历史库存来源" width="960px" :close-on-click-modal="false" :close-on-press-escape="!shippedReceiptDialog.saving" :show-close="!shippedReceiptDialog.saving">
      <el-alert title="该订单已发货，系统只是在核对当时的库存来源，不会新增采购需求。仅在确认对应采购批次已于发货前实际到货时，才补登记实收；若由已有库存或其他来源发货，请到采购台账补录来源。" type="warning" :closable="false" />
      <el-table :data="shippedReceiptDialog.records" max-height="420" border>
        <el-table-column label="订单 / 对应数量" min-width="210"><template #default="{row}"><div v-for="order in row.orders" :key="order.order_id">{{ order.posting_number }} · {{ order.quantity }} {{ row.unit }}</div></template></el-table-column>
        <el-table-column label="采购批次 / 商品" min-width="210"><template #default="{row}">#{{ row.id }} {{ row.purchase_order_no }}<br />{{ row.product_name }}</template></el-table-column>
        <el-table-column prop="remaining_quantity" label="批次待收" width="100" />
        <el-table-column label="确认当时已到货" width="185"><template #default="{row}"><el-input-number v-model="row.quantity" :min="0" :max="Math.min(row.remaining_quantity, row.orders.reduce((sum, order) => sum + order.quantity, 0))" :precision="0" :disabled="shippedReceiptDialog.saving" size="small" /> {{ row.unit }}</template></el-table-column>
      </el-table>
      <p v-if="!shippedReceiptDialog.records.length">没有可直接补登的批次，请查看下方核对原因。</p>
      <el-collapse v-if="shippedReceiptDialog.skipped.length"><el-collapse-item :title="`需另行核对 ${shippedReceiptDialog.skipped.length} 单`"><p v-for="row in shippedReceiptDialog.skipped" :key="row.order_id">{{ row.posting_number }}：{{ row.reason }}</p></el-collapse-item></el-collapse>
      <template #footer><el-button :disabled="shippedReceiptDialog.saving" @click="shippedReceiptDialog.visible=false">取消</el-button><el-button :disabled="shippedReceiptDialog.saving" @click="emit('review')">去采购台账核对</el-button><el-button :disabled="shippedReceiptDialog.saving" :loading="shippedReceiptDialog.loading" @click="emit('preview')">重新预览</el-button><el-button type="primary" :loading="shippedReceiptDialog.saving" :disabled="!shippedReceiptDialog.records.length || shippedReceiptDialog.loading" @click="emit('confirm')">确认当时已到货并补登入库</el-button></template>
    </el-dialog>
</template>

<script setup>
import { computed } from 'vue';
import { ozonReturnOfficialUrl } from '../../../src/shared/ozon-return-state.js';
import { formatDateTime } from '../utils/order-format.js';
const props=defineProps({row:{type:Object,required:true}});
const emit=defineEmits(['close','open-profit']);
const records=computed(()=>props.row.aftersale?.observations||[]);
</script>

<template>
  <el-dialog :model-value="true" title="售后进度与处理方式" width="660px" append-to-body @close="emit('close')">
    <p class="aftersale-order">订单 {{ row.posting_number || row.postingNumber || row.id }} · {{ row.shop_name || row.shopName }}</p>
    <el-alert :type="row.aftersale?.requires_user_action ? 'warning' : 'info'" :closable="false" :title="row.aftersale?.next_action" show-icon />
    <p class="aftersale-note">这里展示 Ozon 的官方进度，不需要点击“确认已退货”。需要卖家回复或审批的申请，请在 Ozon 处理；进度由系统每小时同步。</p>
    <section v-for="record in records" :key="`${record.source_endpoint}:${record.return_id}`" class="aftersale-record">
      <div class="aftersale-record-heading">
        <strong>{{ record.label }}</strong>
        <el-tag v-if="record.action_owner === 'seller'" type="warning" size="small">需要你在 Ozon 处理</el-tag>
        <el-tag v-else-if="record.action_owner === 'system'" type="info" size="small">系统需补充识别</el-tag>
        <el-tag v-else type="info" size="small">无需在 ERP 确认</el-tag>
      </div>
      <p v-if="record.product?.name">{{ record.product.name }}</p>
      <p>{{ record.next_action }}</p>
      <dl class="aftersale-facts">
        <dt>售后申请编号</dt><dd>{{ record.return_id }}</dd>
        <dt>申请时间</dt><dd>{{ record.created_at ? formatDateTime(record.created_at) : '官方未返回' }}</dd>
        <dt>最近同步时间</dt><dd>{{ record.observed_at ? formatDateTime(record.observed_at) : '未记录' }}（北京时间）</dd>
      </dl>
      <el-collapse>
        <el-collapse-item title="查看官方状态依据" :name="String(record.return_id)">
          <div>{{ record.state?.state_name || '官方未返回状态说明' }}</div>
          <div>官方状态：{{ record.official_state || '未返回' }}</div>
          <div>处理阶段：{{ record.state?.group_state || '未单独返回' }}</div>
        </el-collapse-item>
      </el-collapse>
      <a :href="ozonReturnOfficialUrl(record)" target="_blank" rel="noopener noreferrer" class="aftersale-official-link">{{ record.action_owner === 'seller' ? '去 Ozon 查看要求并处理' : '在 Ozon 查看申请' }}</a>
    </section>
    <p class="aftersale-note">如官方页面看不到申请，请先切换到本订单对应的店铺。售后进度与财务结算分别记录；退款金额、费用返还和货损请在利润明细中核对。</p>
    <template #footer>
      <el-button @click="emit('open-profit', row.id)">查看利润明细</el-button>
      <el-button type="primary" @click="emit('close')">知道了</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.aftersale-order{font-weight:600;margin-top:0}.aftersale-note{color:#64748b;font-size:13px;line-height:1.7}
.aftersale-record{border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;overflow-wrap:anywhere}
.aftersale-record-heading{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.aftersale-record p{line-height:1.7}
.aftersale-facts{display:grid;grid-template-columns:112px 1fr;gap:8px;font-size:13px}.aftersale-facts dt{color:#64748b}.aftersale-facts dd{margin:0}
.aftersale-official-link{display:inline-block;margin-top:12px;color:#2563eb;text-decoration:none}
</style>

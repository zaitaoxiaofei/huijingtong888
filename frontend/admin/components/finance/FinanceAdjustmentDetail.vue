<script setup>
import {shanghaiDateTimeText} from '../../utils/shanghai-date.js';
defineProps({records:{type:Array,default:()=>[]}});
const money=v=>v==null?'—':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const amounts=r=>[
 {name:'收入',original:r.original_before?.revenue,before:r.before?.revenue,after:r.after.net_revenue},
 {name:'佣金',original:r.original_before?.commission,before:r.before?.commission,after:r.after.commission_fee},
 ...(r.after.policy==='official-cny-income-commission-v1'?[]:[
 {name:'其他成本（保持原值）',before:r.before?.other_costs,after:r.after.other_costs_cny},
 {name:'其他成本不变的利润试算',before:r.before?.profit,after:r.after.net_profit_cny}
 ])
];
function openFile(url){if(/^\/uploads\/team-attachments\/[^/]+$/.test(url||''))window.open(url,'_blank','noopener,noreferrer');}
</script>
<template>
 <section v-for="record in records" :key="record.id" class="adjustment-detail">
  <h3>调整 #{{record.id}} · {{record.posting_number}} · SKU {{record.sku}}</h3>
  <el-alert v-if="record.status==='stale'" title="原账或凭证已变化，此记录未应用，请重新核对" type="warning" :closable="false"/>
  <p>{{shanghaiDateTimeText(record.created_at)}} · {{record.status==='applied'?'已应用':record.status==='superseded'?'已被后续调整替代':'待重新核对'}}<span v-if="record.after.payment_basis?.status==='verified_zero'"> · 支付费净额已核实为0</span></p>
  <el-table :data="amounts(record)" border>
   <el-table-column prop="name" label="项目 / CNY" min-width="240"/>
   <el-table-column v-if="record.after.policy==='official-cny-income-commission-v1'" label="保留的原账" min-width="140" align="center"><template #default="{row}">{{money(row.original)}}</template></el-table-column>
   <el-table-column label="调整前" min-width="140" align="center"><template #default="{row}">{{money(row.before)}}</template></el-table-column>
   <el-table-column label="调整后" min-width="140" align="center"><template #default="{row}">{{money(row.after)}}</template></el-table-column>
   <el-table-column label="变化" min-width="140" align="center"><template #default="{row}">{{row.before==null||row.after==null?'—':money(row.after-row.before)}}</template></el-table-column>
  </el-table>
  <p>原账保留；其他费用未调整，完整利润仍待核对。</p>
  <p v-if="record.after.policy==='official-cny-income-commission-v1'">收入与佣金采用官方合同CNY金额，未再次折算。下单月份与原件报告月份分别保留。</p>
  <el-collapse><el-collapse-item title="调整依据与原件" :name="record.id">
   <p>{{record.reason}}</p>
   <p v-for="source in record.sources" :key="source.document_id"><el-button v-if="!source.unavailable" link type="primary" @click="openFile(source.attachment_url)">原件 #{{source.document_id}} · {{source.original_name}}</el-button><span v-else>原件 #{{source.document_id}} 当前不可用</span><small v-if="source.month">报告月份：{{source.month}}</small><small>SHA256：{{source.sha256}}</small></p>
   <p v-if="record.after.payment_basis?.operation_ids?.length">零支付费流水：{{record.after.payment_basis.operation_ids.join('、')}}</p>
  </el-collapse-item></el-collapse>
 </section>
</template>
<style scoped>
.adjustment-detail{margin-bottom:22px}.adjustment-detail h3{font-size:15px}.adjustment-detail p{color:var(--el-text-color-secondary);line-height:1.7}.adjustment-detail small{display:block;overflow-wrap:anywhere}
</style>

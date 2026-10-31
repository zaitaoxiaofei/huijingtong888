<script setup>
import { computed } from 'vue';
import ProductImagePreview from '../../admin/components/ProductImagePreview.vue';
import { shanghaiDateTimeText } from '../../admin/utils/shanghai-date.js';
import { buildProductDisplayRows } from '../utils/order-display.js';
import { orderStateKey, STATE_META } from '../constants/orders-ui.js';
const props=defineProps({rows:{type:Array,default:()=>[]},selected:{type:Object,default:()=>new Map()},reviewed:{type:Object,default:()=>new Map()},pageSelected:Boolean,removable:Boolean});
const emit=defineEmits(['toggle','toggle-page','review','open-order','open-batch']);
const displayed=computed(()=>props.rows.map(row=>({...row,products:row.productDisplayRows||buildProductDisplayRows(row)})));
const time=value=>value?shanghaiDateTimeText(value,{assumeUtcWhenNaive:true}):'未记录';
const money=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value))?Number(value).toFixed(2):'未加载';
const blocked=row=>row.blocked||row.unknown||row.can_select===false;
</script>
<template>
 <el-table class="ogl-order-table" :data="displayed" row-key="id" border height="380" empty-text="当前筛选没有订单，可切换状态查看不可加入原因，或调整打印日期">
  <el-table-column v-if="!removable" width="46" fixed="left"><template #header><el-checkbox :model-value="pageSelected" aria-label="选择本页可发运订单" @change="emit('toggle-page',$event)"/></template><template #default="{row}"><el-checkbox :model-value="selected.has(Number(row.id))" :disabled="blocked(row)" :aria-label="'选择订单 '+row.posting_number" @change="checked=>emit('toggle',row,checked)"/></template></el-table-column>
  <el-table-column label="订单 / 店铺" min-width="220" fixed="left"><template #default="{row}"><el-button link type="primary" @click="emit('open-order',Number(row.id))">{{row.posting_number||row.id}}</el-button><small>{{row.shop_name||'店铺待核对'}}</small><small>{{STATE_META[orderStateKey(row)]?.label||row.status||'状态待核对'}}</small><el-tag v-if="row.already_bound" size="small">已在当前申请</el-tag></template></el-table-column>
  <el-table-column label="商品信息" min-width="340"><template #default="{row}"><div v-for="(product,index) in row.products" :key="product.orderItemId||product.sku||index" class="ogl-order-product"><ProductImagePreview :src="product.imageUrl||''" :preview-list="product.imageUrl?[product.imageUrl]:[]"/><div><span>{{product.name||'商品名称待加载'}}</span><small>SKU：{{product.sku||'未记录'}} · 数量 {{product.quantity||row.item_count||'待核对'}}</small><small v-if="product.inventoryNumber">库存 ID：{{product.inventoryNumber}} · {{product.inventoryName}}</small></div></div></template></el-table-column>
  <el-table-column label="利润（CNY）" min-width="140"><template #default="{row}"><div>金额：{{money(row.revenue)}}</div><small>预计：{{money(row.estimated_profit)}}</small><small>真实：{{Number(row.actual_profit_ready)===1?money(row.actual_profit):'待结算'}}</small><el-button link type="primary" @click="emit('open-order',Number(row.id))">查看明细</el-button></template></el-table-column>
  <el-table-column label="下单 / 打印时间" min-width="190"><template #default="{row}"><div>下单：{{time(row.ordered_at)}}</div><small>打印：{{time(row.printed_at)}}</small><small>更新：{{time(row.last_synced_at)}}</small><small v-if="row.print_batch_id">打印批次：{{row.print_batch_id}}</small></template></el-table-column>
  <el-table-column label="物流信息" min-width="240"><template #default="{row}"><div>{{row.fulfillment_type_label||row.logistics_fulfillment_type?.toUpperCase()||'FBS'}} · {{row.logistics_carrier_label||'物流待核对'}}</div><small>{{row.logistics_method_label||row.delivery_method_name||row.logistics_channel||'物流方式待加载'}}</small><small>仓库：{{row.warehouse_name||'未记录'}}</small><small>货件：{{row.posting_number}}</small><small>追踪：{{row.tracking_number||'未记录'}}</small></template></el-table-column>
  <el-table-column label="库存信息" min-width="220"><template #default="{row}"><div v-for="(product,index) in row.products" :key="index"><span>{{product.inventoryNumber?`库存 ID：${product.inventoryNumber}`:'库存绑定待核对'}}</span><small>{{product.inventoryName}}</small><small v-if="product.stock&&!product.unbound&&(row.order_details_loaded||row.productDisplayRows?.length)">本地可用：{{product.stock.local??product.stock.fbs??'待核对'}} · FBP：{{product.stock.fbp??'待核对'}}</small></div></template></el-table-column>
  <el-table-column label="标记 / 人工备注" min-width="200"><template #default="{row}"><span>{{row.mark_type||'无标记'}}</span><small class="ogl-order-note">{{row.mark_note||'无备注'}}</small><el-checkbox v-if="row.needs_review&&!blocked(row)" :model-value="reviewed.get(Number(row.id))===row.review_signature" @change="checked=>emit('review',row,checked)">已人工复核</el-checkbox></template></el-table-column>
  <el-table-column label="加入状态 / 原因" min-width="230"><template #default="{row}"><el-tag :type="blocked(row)?'warning':'success'" size="small">{{blocked(row)?'不可加入':row.needs_review?'复核后可加入':'可加入'}}</el-tag><small>{{row.reason|| (row.unknown?'订单详情待核对':'绑定后仍待仓库确认实际交运')}}</small><el-button v-if="row.active_batch_id&&blocked(row)" link type="primary" @click="emit('open-batch',Number(row.active_batch_id))">查看原批次</el-button></template></el-table-column>
  <el-table-column v-if="removable" label="操作" width="80" fixed="right"><template #default="{row}"><el-button link type="danger" @click="emit('toggle',row,false)">移除</el-button></template></el-table-column>
 </el-table>
</template>
<style scoped>
.ogl-order-table small{display:block;margin-top:5px;color:var(--el-text-color-secondary);font-size:12px;white-space:normal;overflow-wrap:anywhere}.ogl-order-product{display:flex;align-items:flex-start;gap:10px;padding:6px 0}.ogl-order-product :deep(.erp-image-preview){width:64px;height:84px;flex:0 0 64px}.ogl-order-product>div{min-width:0}.ogl-order-note{white-space:pre-wrap!important}
</style>

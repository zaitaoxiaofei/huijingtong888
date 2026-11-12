<script setup>
import { computed, ref, watch } from 'vue';
import MarketplaceBadge from '../../components/MarketplaceBadge.vue';
import { createDemoOrders, demoListings, demoProducts, demoPromotions, demoShops, filterMarketplaceRows, sharedAvailable } from './demo-data.js';

const tab = ref('orders'), platform = ref(''), shop = ref(''), search = ref('');
const orders = ref(createDemoOrders()), detail = ref(null), notice = ref('');
const tabs = [{ key: 'orders', label: '订单处理' }, { key: 'listings', label: '线上商品 / 上架' }, { key: 'products', label: '基础商品' }, { key: 'inventory', label: '库存总览' }, { key: 'promotions', label: '平台活动' }];
const isShared = computed(() => ['products', 'inventory'].includes(tab.value));
const shops = computed(() => demoShops.filter(row => !platform.value || row.platform === platform.value));
const rows = computed(() => filterMarketplaceRows(({ orders: orders.value, listings: demoListings, products: demoProducts, inventory: demoProducts, promotions: demoPromotions })[tab.value], { platform: platform.value, shop: isShared.value ? '' : shop.value, search: search.value }));
watch(tab, () => { notice.value = ''; detail.value = null; });
function changePlatform() { shop.value = ''; }
function advance(row) {
  const next = { '待处理': '待打印', '待打印': '待交接', '待交接': '已交接' }[row.status];
  if (!next) return;
  row.status = next;
  notice.value = `${row.number} 已演示进入“${next}”；仅更新当前页面示例，未调用平台或打印机。`;
}
function actionLabel(row) { return ({ '待处理': '确认备货', '待打印': '打印面单', '待交接': '确认交接' })[row.status] || '已完成'; }
function reset() { orders.value = createDemoOrders(); notice.value = ''; detail.value = null; }
</script>

<template>
  <div class="marketplace-demo">
    <div class="demo-heading"><div><h2>多平台工作台 <el-tag type="warning">框架 Demo</el-tag></h2><p>同一套操作，同一个本地仓；通过平台标识和店铺名称区分记录。</p></div><el-button @click="reset">重置演示</el-button></div>
    <el-alert title="当前全部为示例数据，不读取或修改真实订单、商品及库存。WB 授权、真实上架、面单、发货及活动报名尚未接通。" type="warning" :closable="false" show-icon />
    <el-tabs v-model="tab"><el-tab-pane v-for="item in tabs" :key="item.key" :name="item.key" :label="item.label" /></el-tabs>
    <div class="demo-filters">
      <el-select v-model="platform" aria-label="销售平台" placeholder="全部平台" clearable @change="changePlatform"><el-option label="Ozon" value="ozon"/><el-option label="WB" value="wb"/></el-select>
      <el-select v-if="!isShared" v-model="shop" aria-label="店铺" placeholder="全部店铺" clearable><el-option v-for="item in shops" :key="item.id" :label="item.name" :value="item.id"/></el-select>
      <el-input v-model="search" aria-label="搜索记录" placeholder="搜索单号、商品、SKU 或店铺" clearable />
      <span class="muted-text">共 {{ rows.length }} 条示例</span>
    </div>
    <el-alert v-if="notice" :title="notice" type="info" :closable="false" />

    <el-table v-if="tab === 'orders'" :data="rows" row-key="id" border stripe class="erp-data-table">
      <el-table-column label="订单信息" min-width="210" fixed="left"><template #default="{ row }"><div class="demo-cell"><MarketplaceBadge :platform="row.platform"/><strong>{{ row.number }}</strong><small>数量 × {{ row.quantity }}</small></div></template></el-table-column>
      <el-table-column label="商品信息" min-width="220"><template #default="{ row }"><div class="demo-cell"><strong>{{ row.name }}</strong><small>内部 SKU：{{ row.sku }}</small></div></template></el-table-column>
      <el-table-column prop="shopName" label="店铺" min-width="190"/>
      <el-table-column label="仓库 / 履约" min-width="160"><template #default="{ row }">{{ row.warehouse }} · {{ row.fulfillment }}</template></el-table-column>
      <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag>{{ row.status }}</el-tag></template></el-table-column>
      <el-table-column label="操作" min-width="180"><template #default="{ row }"><el-button link type="primary" :disabled="row.status === '已交接'" @click="advance(row)">{{ actionLabel(row) }}</el-button><el-button link @click="detail = { title: '订单详情', row }">查看详情</el-button></template></el-table-column>
    </el-table>

    <el-table v-else-if="tab === 'listings'" :data="rows" row-key="id" border stripe class="erp-data-table">
      <el-table-column label="商品 / 平台" min-width="240"><template #default="{ row }"><div class="demo-cell"><MarketplaceBadge :platform="row.platform"/><strong>{{ row.name }}</strong><small>{{ row.number }}</small></div></template></el-table-column>
      <el-table-column prop="shopName" label="店铺" min-width="190"/><el-table-column prop="sku" label="绑定内部 SKU" min-width="150"/>
      <el-table-column label="售价" width="130"><template #default="{ row }">{{ row.price }} RUB</template></el-table-column>
      <el-table-column prop="status" label="状态" width="120"/><el-table-column label="操作" min-width="150"><template #default="{ row }"><el-button link type="primary" @click="detail = { title: '商品编辑预览', row }">编辑 / 查看</el-button></template></el-table-column>
    </el-table>

    <el-table v-else-if="tab === 'products'" :data="rows" row-key="sku" border stripe class="erp-data-table">
      <el-table-column prop="sku" label="内部 SKU" min-width="150"/><el-table-column prop="name" label="基础商品" min-width="220"/>
      <el-table-column label="已关联销售平台" min-width="180"><template #default="{ row }"><div class="demo-platforms"><MarketplaceBadge v-for="value in row.platforms" :key="value" :platform="value"/></div></template></el-table-column>
      <el-table-column label="库存关系" min-width="220"><template #default>一个内部 SKU，关联两个平台商品，共用本地库存</template></el-table-column>
    </el-table>

    <template v-else-if="tab === 'inventory'">
      <el-alert title="本地可分配 = 本地实物 − 两平台订单预占 − 调拨预占 − 安全库存。平台仓数量单独记录，不计入本地可售。平台筛选仅筛商品关联，不改变实物数量。" type="info" :closable="false"/>
      <el-table :data="rows" row-key="sku" border stripe class="erp-data-table">
        <el-table-column prop="sku" label="内部 SKU" min-width="140" fixed="left"/><el-table-column prop="name" label="商品" min-width="180"/>
        <el-table-column prop="local" label="本地实物" width="110"/><el-table-column prop="ozonReserved" label="Ozon 预占" width="110"/><el-table-column prop="wbReserved" label="WB 预占" width="100"/>
        <el-table-column prop="transferReserved" label="调拨预占" width="110"/><el-table-column prop="safety" label="安全库存" width="110"/>
        <el-table-column label="本地可分配" width="120"><template #default="{ row }"><strong>{{ sharedAvailable(row) }}</strong></template></el-table-column>
        <el-table-column prop="ozonFbp" label="Ozon FBP 在库" width="145"/><el-table-column label="WB 平台仓" width="170"><template #default>0 · 后续接入</template></el-table-column>
      </el-table>
    </template>

    <el-table v-else :data="rows" row-key="id" border stripe class="erp-data-table">
      <el-table-column label="活动 / 平台" min-width="240"><template #default="{ row }"><div class="demo-cell"><MarketplaceBadge :platform="row.platform"/><strong>{{ row.name }}</strong></div></template></el-table-column>
      <el-table-column prop="shopName" label="店铺" min-width="190"/><el-table-column prop="sku" label="参与商品" width="150"/><el-table-column prop="status" label="状态" width="120"/>
      <el-table-column label="操作" min-width="140"><template #default="{ row }"><el-button link type="primary" @click="detail = { title: '活动报名预览', row }">查看报名条件</el-button></template></el-table-column>
    </el-table>
    <el-empty v-if="!rows.length" description="没有匹配的示例，请调整平台、店铺或搜索条件"/>

    <el-drawer :model-value="!!detail" :title="detail?.title" size="min(520px, 100vw)" @close="detail = null">
      <template v-if="detail"><div class="demo-cell"><MarketplaceBadge :platform="detail.row.platform"/><h3>{{ detail.row.number }}</h3><p>{{ detail.row.shopName }}</p><p>{{ detail.row.name }} · {{ detail.row.sku }}</p><p v-if="detail.row.status">当前示例状态：{{ detail.row.status }}</p>
      <el-alert :title="tab === 'promotions' ? '真实接入后，这里展示平台返回的报名资格、活动价格要求和提交结果。本次仅预览，不提交报名。' : tab === 'listings' ? '真实接入后，这里按平台加载类目、属性、价格及图片编辑。当前仅展示示例，不保存或发布。' : '真实接入后，统一操作会分别执行对应平台的备货、标签和交接流程。当前仅演示界面。'" type="info" :closable="false"/></div></template>
    </el-drawer>
  </div>
</template>

<style scoped>
.marketplace-demo{display:grid;gap:16px;min-width:0}.demo-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.demo-heading h2{margin:0 0 8px}.demo-heading p{margin:0;color:var(--el-text-color-secondary)}.demo-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.demo-filters .el-select{width:190px}.demo-filters .el-input{width:300px}.demo-cell{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:8px 0}.demo-cell small{color:var(--el-text-color-secondary)}.demo-platforms{display:flex;gap:8px}.marketplace-demo :deep(.el-table){width:100%}.marketplace-demo :deep(.el-table__row){height:92px}@media(max-width:640px){.demo-heading{align-items:flex-start}.demo-filters .el-select,.demo-filters .el-input{width:100%}}
</style>

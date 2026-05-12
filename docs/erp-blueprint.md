# 本地轻 ERP 系统蓝图

> 目标：从当前 Ozon Profit Hub 演进为本地可部署、后续可扩展的小型 ERP。第一阶段仍保持本地部署优先，不依赖飞书。

## 一句话定位

系统以实物 SKU 为成本和库存核心，以 Ozon SKU 为销售表现核心：

- Ozon SKU 负责销售表现和负责人贡献。
- 实物 SKU 负责成本、库存、采购和补货。
- 店铺维度负责利润、分红和经营质量。
- 负责人维度负责上品贡献、动销质量和绩效分析。
- 订单流水负责追溯。
- 库存流水负责查账。

## 总体架构

```text
Ozon 多店铺 API
  ↓
同步服务 Sync Service
  ↓
本地数据库
  ↓
业务计算层 Business Service
  ↓
本地网页后台 Admin Dashboard
```

当前项目第一版采用：

- 后端：Node.js 原生 HTTP API
- 数据库：SQLite
- 前端：原生 HTML/CSS/JS
- 定时任务：第一阶段先手动同步，后续加入本地计划任务

后续订单量上来后，可平滑升级到：

- 后端：FastAPI / Node.js 服务化
- 数据库：PostgreSQL
- 前端：React / Vue
- 任务：APScheduler / Celery / cron

## 核心模块

### 1. 店铺管理

管理多个 Ozon 店铺的 API 凭据、负责人、同步状态和默认佣金规则。

目标字段：

- `id`
- `store_name`
- `ozon_client_id`
- `ozon_api_key_encrypted`
- `owner_person`
- `default_commission_under_1500`
- `default_commission_over_1500`
- `is_active`
- `last_sync_time`

当前对应表：`shops`

### 2. 实物产品库

实物产品库是库存和成本的核心。一个实物产品可以绑定多个店铺 SKU。

目标字段：

- `id`
- `real_sku`
- `product_name`
- `category`
- `car_model`
- `supplier_name`
- `purchase_url`
- `purchase_cost_cny`
- `domestic_shipping_cny`
- `international_shipping_cny`
- `packaging_cost_cny`
- `weight`
- `volume`
- `default_commission_rate`
- `remark`
- `image_url`
- `status`

当前对应表：`products`

### 3. 店铺 SKU 映射

这是系统最关键的关系表。

核心规则：

- 一个实物产品可以绑定多个 Ozon SKU。
- 一个 Ozon SKU 只能绑定一个实物产品。
- 一个 Ozon SKU 必须绑定一个负责人。
- 成本跟实物 SKU 走。
- 负责人贡献跟 Ozon SKU 走。

目标字段：

- `id`
- `store_id`
- `ozon_sku`
- `offer_id`
- `ozon_product_id`
- `ozon_product_name`
- `real_product_id`
- `sku_owner_person`
- `listing_person`
- `image_version`
- `sale_price_rub`
- `status`

当前对应表：`online_products` + `sku_mappings`

### 4. 订单同步与追溯

Ozon 订单建议分两层保存。

原始订单表：

- `id`
- `store_id`
- `posting_number`
- `order_id`
- `status`
- `substatus`
- `raw_json`
- `fetched_at`

业务订单明细表：

- `id`
- `store_id`
- `posting_number`
- `order_id`
- `ozon_sku`
- `offer_id`
- `real_product_id`
- `sku_owner_person`
- `quantity`
- `sale_price_rub`
- `sale_price_cny`
- `order_status`
- `cancel_status`
- `return_status`
- `created_at`
- `shipped_at`
- `delivered_at`
- `last_status_sync_time`

当前对应表：`orders` + `order_items`

下一步建议新增：`ozon_orders_raw`

### 5. 利润计算系统

利润不要只塞在订单表里，建议单独保留费用明细，方便后续广告、售后、财务对账扩展。

目标表：`order_profit_items`

- `id`
- `order_item_id`
- `sale_amount_cny`
- `purchase_cost_cny`
- `domestic_shipping_cny`
- `international_shipping_cny`
- `packaging_cost_cny`
- `commission_rate`
- `commission_fee_cny`
- `ozon_service_fee_cny`
- `return_loss_cny`
- `advertising_cost_cny`
- `other_fee_cny`
- `gross_profit_cny`
- `net_profit_cny`
- `profit_status`

第一版公式：

```text
净利润 =
销售额
- 采购成本
- 国内运费
- 国际运费
- 包装成本
- Ozon 佣金
- Ozon 服务费
- 广告费
- 售后损失
- 其他费用
```

第一版佣金规则：

- 1500 卢布以下：12%
- 1500 卢布以上：17%

后续升级为类目佣金表。

### 6. 库存系统

库存分两层：当前库存 + 库存流水。

当前库存表：`inventory_current`

- `real_product_id`
- `available_stock`
- `reserved_stock`
- `damaged_stock`
- `in_transit_stock`
- `last_updated_at`

库存流水表：`inventory_movements`

- `id`
- `real_product_id`
- `movement_type`
- `quantity_change`
- `related_posting_number`
- `related_order_item_id`
- `reason`
- `operator`
- `created_at`

库存动作：

- `PURCHASE_IN`：采购入库
- `ORDER_RESERVED`：订单锁库存
- `ORDER_SHIPPED`：发货扣库存
- `CANCEL_RESTORE`：发货前取消恢复
- `RETURN_PENDING`：退货待确认
- `RETURN_IN`：退货入库
- `RETURN_LOSS`：退货损耗
- `MANUAL_ADJUST`：手动调整

第一版库存状态机：

```text
新订单
  ↓
reserved_stock + quantity

确认发货
  ↓
available_stock - quantity
reserved_stock - quantity

发货前取消
  ↓
reserved_stock - quantity

发货后退货
  ↓
RETURN_PENDING
  ↓
人工确认可二次销售 → available_stock + quantity
人工确认损坏/丢失 → damaged_stock + quantity
```

当前项目已有：`inventory_movements`

下一步建议新增：`inventory_current`

### 7. 分析看板

第一阶段前端应覆盖 5 个页面。

总览看板：

- 今日订单数
- 今日销售额
- 今日净利润
- 今日利润率
- 近 7 天趋势
- 异常订单数
- 低库存 SKU 数

店铺利润看板：

- 店铺
- 订单数
- 销售额
- 采购成本
- 物流成本
- 佣金
- 广告费
- 售后损失
- 净利润
- 利润率

负责人贡献看板：

- 负责人
- 订单数
- 销售额
- 净利润
- 动销 SKU 数
- 爆款 SKU 数
- 亏损 SKU 数
- 平均利润率
- 广告 ROI

库存看板：

- 实物 SKU
- 产品名
- 当前库存
- 锁定库存
- 在途库存
- 近 7 天销量
- 日均销量
- 可售天数
- 建议补货量
- 供应商
- 采购链接

订单追溯页：

- 订单号
- 店铺
- Ozon SKU
- 实物 SKU
- 负责人
- 售价
- 成本结构
- 利润
- 订单状态变化
- 库存变化
- 售后记录

## 关键业务规则

### 规则 1：Ozon SKU 必须绑定实物 SKU

未绑定 SKU 不进入利润计算，进入异常列表。

### 规则 2：成本跟实物 SKU 走

同一个实物 SKU，不管在哪个店铺卖，默认成本一致。

### 规则 3：负责人跟 Ozon SKU 走

同一个实物产品可能由不同人做不同链接、主图和运营动作，贡献归属应绑定到店铺 SKU。

### 规则 4：店铺利润和负责人贡献分开算

店铺利润用于分红和经营质量判断；负责人贡献用于提成、选品能力和上新质量评估。

### 规则 5：库存跟实物 SKU 走

多个店铺共享同一个实物产品库存，不按 Ozon SKU 分裂库存。

### 规则 6：异常订单必须人工确认

异常包括：

- 未映射 SKU
- 成本缺失
- 发货后取消
- 退货
- 价格异常
- 库存不足

第一版不要追求全自动，异常必须人工确认。

## MVP 范围

第一版只做：

1. 多店铺 API 绑定
2. 订单自动同步
3. SKU 映射
4. 实物产品成本库
5. 自动利润计算
6. 自动库存锁定/扣减
7. 店铺利润看板
8. 负责人贡献看板
9. 库存预警
10. 异常订单列表

暂不做：

- 自动采购
- 复杂广告归因
- 复杂 Ozon 财务对账
- 自动预测爆款
- 自动生成采购单

## 开发顺序

### 第一步：主数据

- 店铺管理
- 实物产品库
- Ozon SKU 映射表
- 人员管理

### 第二步：订单同步

- 最近 7 天订单同步
- 手动同步按钮
- 定时自动同步
- 同步日志
- 失败重试

### 第三步：利润计算

- 售价
- 采购成本
- 国际运费
- 佣金
- 包装成本
- 广告、退货、其他费用预留字段

### 第四步：库存扣减

- 下单锁库存
- 发货扣库存
- 发货前取消释放库存
- 退货进入异常列表

### 第五步：看板

- 总览
- 店铺利润
- 负责人贡献
- 库存预警

## 扩展路线

### 阶段一：100-300 单/天

- 订单同步
- 利润计算
- 库存预警
- 异常订单

### 阶段二：300-800 单/天

- 采购建议
- 供应商交期管理
- 广告数据录入
- 退货成本模型
- 多币种汇率

### 阶段三：800 单+/天

- 自动补货建议
- Ozon 财务对账
- 员工权限系统
- 操作日志
- 绩效模型
- 仓库扫码出库

## 开发前必须固定的 3 件事

### 1. 实物 SKU 编码规则

建议格式：

```text
类目-车型-产品-材质-颜色-版本
```

示例：

```text
KEY-TENET-T4-TPU-BK-V1
SILL-TENET-T4-SS-4PCS-V1
PAD-TENET-T4-LEATHER-BK-V1
```

### 2. 负责人规则

第一版规则：

```text
谁创建这个 Ozon SKU，谁是 SKU 负责人
```

后续可增加协作人和贡献比例。

### 3. 库存扣减规则

第一版规则：

```text
下单锁库存
发货扣库存
发货前取消释放
发货后退货人工确认
```

## 当前项目差距清单

已经具备：

- 多店铺基础表：`shops`
- 人员表：`people`
- 实物产品表：`products`
- 在线商品表：`online_products`
- SKU 映射表：`sku_mappings`
- 订单表：`orders`
- 订单明细表：`order_items`
- 库存流水表：`inventory_movements`
- 基础利润计算：`src/profit.js`
- 模拟 Ozon 同步：`src/ozonClient.js`

需要补齐：

- 原始 Ozon 订单落库表：`ozon_orders_raw`
- 当前库存汇总表：`inventory_current`
- 利润费用明细表：`order_profit_items`
- 异常订单表或异常状态字段
- 真实 Ozon API 适配层
- 同步任务日志和失败重试
- 店铺利润看板
- 负责人贡献看板
- 订单追溯详情页增强
- 库存状态机：锁定、发货、取消、退货

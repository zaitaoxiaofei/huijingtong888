# 数据分析运营待办规划

## 目标

把 Ozon 店铺真实流量转化数据从“指标看板”升级为“商品运营待办系统”。

核心闭环：

```text
插件定时采集 -> 本地结构化入库 -> 商品诊断分层 -> 生成运营待办 -> 记录动作 -> 次日复盘
```

## 数据同步节奏

- 每天全量同步三次：上午、下午、晚上。
- 插件负责从 `seller.ozon.ru/app/analytics` 拉取 Ozon 官方分析接口数据。
- ERP 本地服务优先保存原始快照和结构化商品指标。
- 页面日常查询只查本地 MySQL，不再依赖实时远程请求。

## 商品运营分层

| 分层 | 判断信号 | 待办动作 |
| --- | --- | --- |
| 放量款 | 曝光、点击、加购、成交都成立 | 补库存、加广告、稳价格、保排名 |
| 流量缺失款 | 曝光低、搜索位置差 | 补类目、属性、关键词，做小预算测词 |
| 卡片弱款 | 曝光高但点击低 | 改主图、标题、价格标签、促销表达 |
| 详情弱款 | 点击高但加购低 | 改详情图、卖点、规格说明、评价内容 |
| 下单弱款 | 加购高但成交低 | 查到手价、运费、优惠门槛、配送时效 |
| 利润风险款 | 有销量但毛利低或广告占比高 | 调价、控广告、换供应链或组合包 |
| 售后风险款 | 退货、取消、评分异常 | 校准描述、尺码、包装和质量问题 |
| 库存风险款 | 有销量但断货或建议补货 | 补货、暂停放量、调整广告预算 |

## 待办表建议

后续新增本地表 `seller_analytics_operation_todos`：

```text
id
tenant_id
shop_id
biz_date
product_id
sku
offer_id
segment
priority
score
problem_type
recommended_action
evidence_json
status
owner
action_taken
resolved_at
created_at
updated_at
```

## 分析结果表建议

后续新增本地表 `seller_analytics_product_diagnosis`：

```text
tenant_id
shop_id
biz_date
period_key
product_id
sku
offer_id
segment
priority
score
main_problem
recommended_action
metrics_json
evidence_json
diagnosed_at
```

页面首屏优先读取这张诊断表；只有查看原始回传或补采时才读取快照表。

## 实施顺序

1. 插件支持线上 ERP 和本地 ERP 配置，并带 token 回传数据。
2. 数据分析页保持本地查询，逐步减少运行时解析原始快照。
3. 采集完成后生成商品诊断结果。
4. 从诊断结果生成每日运营待办。
5. 增加动作记录和复盘：动作前后 1-3 天指标变化。

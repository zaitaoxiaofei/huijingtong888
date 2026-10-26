# Ozon 财务流水与利润证据

核对日期：2026-10-26，北京时间。当前代码读取 `/v3/finance/transaction/list`，不能仅以请求函数正常返回或已有历史流水断言账单来源正常。

后续进展：本轮已实际读取官方新按日接口和 135 项费用类型字典，完成独立适配及实库管道测试，详见 [finance-accruals.md](finance-accruals.md)。旧 V1 保留原行为，新来源在 V2 启用后接入；本文下方保留发现旧来源故障时的证据和迁移约束。

## 已验证的生产故障

本轮只读查询确认，`ozon_finance_items` 最新 `operation_date` 为 2026-09-08；2026-10-26 最近五次 `ozon_finance_raw` 同步均为 `partial_error`。最新错误对当前六家店铺均为 `Ozon /v3/finance/transaction/list failed: 404 page not found`。这是当前生产实际观测，不是证明所有 Ozon 账号均以相同形式停用。没有执行生产账单导入、利润重算或删除。

官方开发者社区的 2026 年讨论提到旧交易列表迁移以及 `/v1/finance/accrual/by-day`、`/v1/finance/accrual/postings`。这些方法不能只替换旧请求 URL：须验证请求日期、游标、逐订单/父单关联、原币金额、佣金/服务费、操作唯一键、费用完整性和企业店铺范围，再映射成内部财务事实。

- 官方账单金额说明：<https://dev.ozon.ru/community/1267-Finansy-Nachisleniia/>。`amount` 是扣除费用后的净操作金额，不能再与总收入及同一套费用重复相加。
- 新按日方法的请求讨论：<https://dev.ozon.ru/community/2218-Utochnenie-formata-otveta-metoda-Poluchit-nachisleniia-za-den/?__rr=1>。示例有 `date` 和 `last_id`，不是旧月范围页号合同。
- 新财务方法限流官方回复：<https://dev.ozon.ru/community/2373-HTTP-429-na-finansovykh-metodakh-Seller-API-pri-redkikh-zaprosakh/>。没有方法专属额度说明时，基准限制按整个 Client-Id 共享；不能把每个任务当作独立额度。

## 原币与人民币核算

生产原始商品金额同时出现卖家价 CNY、买家价 RUB 和佣金币种 RUB；金额也可能为 `{price/value/amount, currency}` 对象。只从选中金额的同一对象读取币种，不借用买家价、其他 financial product 或在线商品币种。原始财务流水最近 200 行没有币种字段；用户随后对照官方财务页面确认收入、佣金和物流原币为卢布，并确认统一以人民币核算和显示的公共业务规则。

经审核的旧接口原币合同可作为该接口缺币种字段的依据；规则记录不包含企业业务数据。若新接口明确返回币种，原始币种优先；其他来源未核实的币种保持待核对，不套用旧合同。企业的订单、成本、账单、计算修订依然隔离。

## 每日汇率与真实利润

新 V2 订单按下单北京日固定预估汇率，按实际签收北京日固定结算汇率。存档汇率方向为 `RUB / CNY`，卢布金额除以该值折人民币；人民币成本不再换汇。签收不代表账单已经齐全，费用后补仍采用同一签收日汇率，实际结果产生新修订。旧 V1 行为和历史换算列不改。

日档可用、公式测试通过、账单接口恢复、真实利润验收是四个独立事实。缺少完整账单时显示待结算，不能把估算收款费补作正式实际费用；净操作金额、费用拆行和重复的销售总额也不能重复累计。

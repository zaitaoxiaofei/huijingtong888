# Ozon 广告历史对账

## 当前口径

- 权威币种为 RUB。
- 广告统计通过 Ozon Performance API 的活动统计报表获取，并按北京时间自然日、自然月汇总。
- `ozon_ad_sku_daily` 是活动商品明细，不应仅凭其中的 `ozon_performance_pending` 行数判断历史月份完整。
- 历史核准必须同时覆盖活动目录、报表返回状态和金额差额。

## 活动发现

历史补数使用当前活动接口、`ozon_ad_campaign_catalog` 历史活动目录，以及 `ozon_ad_sku_daily` 已出现过的活动 ID 的并集。即使活动以后停止、归档或不再出现在当前列表中，历史活动 ID 仍可继续参与补数。

## 审计和修复接口

- `GET /api/advertising/history/audit?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /api/advertising/history/repair`

实际补数请求示例：

```json
{
  "from": "2026-05-01",
  "to": "2026-05-31",
  "apply": true,
  "shop_ids": [4],
  "campaign_cursor": 0,
  "max_campaigns_per_shop": 1
}
```

保护规则：

- 默认只审计，并排除北京时间当天。
- 实际修复每次只能指定一个店铺，默认每批只处理一个活动。
- Ozon 报表未生成时不覆盖现有金额。
- 历史核准状态独立记录在 `ozon_ad_history_reconciliation`，不能用普通 pending 行数替代。

## 已知限制

Ozon 历史活动报表可能超过 10 分钟仍未生成。后续应使用持久化后台队列保存报表 UUID、轮询状态、重试时间和活动游标，不依赖单次 HTTP 请求保持连接。

## 本地验证

仅使用专用本地端口 `8788`。不得自动操作 `8787` 或 `8087`。

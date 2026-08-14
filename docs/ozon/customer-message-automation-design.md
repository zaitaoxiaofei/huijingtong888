# Ozon 自动客户消息设计

## 目标与边界

- 使用统一公网入口 `POST https://erp.hjt888.xyz/api/webhooks/ozon` 接收所有店铺的 Ozon Push 通知。
- 根据通知中的 `seller_id` 映射 ERP 店铺，不为每个店铺生成不同 URL。
- Webhook 只接收和入库，不在请求链路中发送客户消息。
- 到达取货点后 1 小时生成取货提醒；签收后 12 小时生成求好评消息。
- 自动客户消息按店铺配置，默认关闭；全局真实发送总闸门默认关闭。
- 保留每 10 分钟一次的订单状态扫描作为漏单兜底。

## 总体流程

```text
Ozon Push 通知
  -> 统一 Webhook
  -> 识别 seller_id 与事件幂等入库
  -> 快速返回 {"result": true}
  -> 后台消费者领取事件
  -> 使用对应店铺凭证向 Ozon 复核订单
  -> 更新本地订单
  -> 创建或取消延迟消息任务
  -> 到期前再次复核订单和聊天权限
  -> 发送到 Ozon
  -> 写入完整发送记录
```

Webhook 与定时扫描最终调用同一个任务物化函数，并使用唯一键防止重复任务。

## 店铺识别

店铺表增加独立字段 `ozon_seller_id`。不要默认认为现有 `ozon_client_id` 永远等于推送中的 `seller_id`；首次收到事件或进行能力检测时可以辅助匹配，但必须由运营确认后保存。

识别顺序：

1. `seller_id` 精确匹配 `shops.ozon_seller_id`。
2. 未匹配时记录为 `unmatched`，不创建任务、不发送消息。
3. 管理页面允许将未匹配的 Seller ID 绑定到店铺，绑定后重放未处理事件。

`TYPE_PING` 用于 Ozon 地址检测，可以不包含店铺信息。它使用独立的服务信息响应，不返回普通通知的 `result` 字段；`time` 使用 ISO 8601 UTC 格式，例如：

```json
{
  "version": "1.0",
  "name": "Ozon Seller API",
  "time": "2026-08-11T06:30:00.000Z"
}
```

`TYPE_PING` 响应中出现 `result` 会触发 Seller 后台的 `WRONG_RESULT_FIELD`；缺少有效的 `time` 会触发 `WRONG_RESULT_TIME_FIELD`。普通通知才使用 `{"result": true}` 确认接收。

## Webhook 接口

### 请求

```http
POST /api/webhooks/ozon
Content-Type: application/json
```

该路由是唯一免 ERP 登录的业务接口。约束：

- 请求体上限 256 KB。
- 只接受 JSON 和 POST。
- 按来源 IP 与 `seller_id` 限流。
- 不记录 API Key、Cookie、Authorization 等敏感请求头。
- 原始载荷入库后立即响应，不等待 Ozon API 查询。

### 响应

有效 JSON、重复事件和暂时无法匹配店铺的事件都返回：

```json
{"result": true}
```

只有请求方法、JSON格式或体积不合法时返回 4xx。业务处理失败通过后台重试解决，避免 Ozon 因业务错误反复推送。

## 事件存储

### `ozon_webhook_events`

| 字段 | 用途 |
| --- | --- |
| `id` | 本地事件ID |
| `event_key` | 幂等键，唯一索引 |
| `event_type` | Ozon事件类型 |
| `seller_id` | Ozon卖家ID |
| `shop_id` | 匹配后的ERP店铺，可为空 |
| `posting_number` | 订单号，可为空 |
| `event_at` | Ozon事件时间 |
| `payload_json` | 原始JSON |
| `status` | received / processing / processed / retry / unmatched / ignored / failed |
| `attempts` | 处理次数 |
| `next_attempt_at` | 下次重试时间 |
| `processing_started_at` | 本次消费开始时间，用作处理租约 |
| `last_error` | 最近错误 |
| `received_at` | ECS接收时间 |
| `processed_at` | 处理完成时间 |

幂等键优先使用 Ozon 提供的事件ID；没有事件ID时，由 `event_type + seller_id + posting_number + 事件时间 + 规范化载荷摘要` 生成 SHA-256。

### 可靠性边界

- 该接口是 HTTP Webhook，不是由 ERP 持有消费游标的 RabbitMQ 队列；ECS 完全不可达期间不能假设 Ozon 会无限期保留事件。
- 只要 Ozon 请求已经到达 ECS，事件会先持久化到 `ozon_webhook_events`，成功入库后才返回确认。
- 后台处理采用 15 分钟租约。服务在事件进入 `processing` 后异常退出时，后续扫描会把超时事件恢复为 `retry`，避免永久卡住。
- 处理失败采用指数退避并最多尝试 6 次；重复推送由 `event_key` 唯一索引去重。
- 每 10 分钟的订单/API同步与消息候选扫描负责补偿 ECS 不可达、Ozon 未重试或事件缺失的时间段，并继续遵守各消息场景的失效窗口。
- 因此系统采用“Push 保证时效、数据库收件箱保证已接收事件不丢、API扫描保证最终补漏”的组合，而不是把 Push 当作唯一事实来源。

## 事件处理规则

| 事件 | 处理 |
| --- | --- |
| `TYPE_PING` | 返回 `version`、`name` 和 ISO 8601 UTC `time` |
| `TYPE_STATE_CHANGED` | 查询订单详情，更新状态并物化消息任务 |
| `TYPE_POSTING_CANCELLED` | 更新订单并取消未发送任务 |
| `TYPE_NEW_POSTING` | 增量同步订单，不自动联系客户 |
| `TYPE_NEW_MESSAGE` | 增量同步聊天消息 |
| `TYPE_UPDATE_MESSAGE` | 更新已有聊天消息 |
| `TYPE_MESSAGE_READ` | 更新已读状态 |
| `TYPE_CHAT_CLOSED` | 关闭线程并取消无法发送的任务 |
| 未知类型 | 保存为 ignored，便于将来兼容 |

推送载荷只作为“发生变化”的信号，不能直接作为发送依据。订单状态、店铺归属和聊天能力必须通过对应店铺的 Ozon API 再次确认。

## 消息任务状态机

```text
pending -> sending -> sent
   |          |
   |          -> retry -> sending
   -> cancelled
retry 超过上限 -> failed
```

发送前必须同时满足：

1. 全局环境总闸门开启。
2. 店铺自动消息开关开启。
3. 店铺聊天能力最近一次检测为可用。
4. 对应模板启用。
5. 订单仍处于与场景相符的状态。
6. 任务唯一键未发送过。
7. 聊天未关闭，且存在可用 `chat_id` 或能成功创建订单聊天。

取货提醒唯一键为 `order_id + pickup_notice`，求好评唯一键为 `order_id + review_request`。

## 前端信息架构

### 客户消息

只保留两个页面：

1. **消息模板**
   - 下单感谢、护照资料提醒、催单回复、超时发货提醒
   - 物流卡顿、配送延误、取货提醒、签收求好评
   - 俄语发送内容和中文释义
   - 已启用店铺数量
   - 编辑内容、编辑适用店铺、启停模板
   - 全局列表分页

2. **发送记录**
   - 筛选：店铺、订单号、消息类型、发送状态、北京时间范围、触发来源
   - 列：订单号、消息类型、消息内容、店铺、发送状态、触发来源、计划时间、发送时间、操作
   - 状态过程：待发送、发送中、待重试、成功、失败、已取消
   - 详情抽屉：Webhook事件、状态复核、聊天ID、每次尝试、Ozon响应、错误原因
   - 全局列表分页

### 系统设置 → 店铺管理

在店铺编辑页增加“自动客户消息”区域：

- Ozon Seller ID
- 自动客户消息开关，默认关闭
- 聊天权限状态及检测按钮
- Webhook状态、最近通知时间
- 统一接收地址及复制按钮
- 取货提醒延迟，默认1小时
- 求好评延迟，默认12小时
- 启用场景：取货提醒、签收求好评

## ECS部署

现有域名和Nginx继续把 `/api/` 转发到ERP Node服务，无需为Webhook开放新的公网端口。上线步骤：

1. 部署包含Webhook接口的ERP版本。
2. 公网请求验证 `TYPE_PING`。
3. 在各Ozon Seller账号中填写同一个地址。
4. 开启订单状态、取消和必要的聊天事件。
5. 在ERP店铺管理中确认 Seller ID 匹配。
6. 观察事件收件箱和发送记录。
7. 先保持全局真实发送关闭，只验证任务生成；人工验收后再单独开启。

人工验收阶段使用独立的 `OZON_CUSTOMER_MESSAGE_MANUAL_TEST_ENABLED` 开关，不复用自动发送总闸门。测试队列只展示三类已经到发送时间的下一条消息；运营逐条预览、二次确认，服务端随后从 Ozon 复核订单状态再发送。相同订单、场景和提醒阶段由测试候选唯一键防止重复发送。

## 验收条件

- 同一个Webhook地址可正确识别至少两个店铺。
- 重复推送不会创建重复事件或重复任务。
- 伪造状态通知不能绕过Ozon API复核触发发送。
- Webhook业务处理失败不会阻塞响应，可后台重试。
- Webhook漏失时，10分钟扫描能补建同一任务且不重复。
- 默认配置和部署后均不会自动发送真实客户消息。
- 所有界面时间按北京时间显示。

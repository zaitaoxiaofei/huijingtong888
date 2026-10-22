# OGL 发运实现与验证

更新时间：2026-10-22（北京时间）。实现分支：`codex/ogl-dispatch-workflow`，从当时最新 `origin/release/2026.10.21-task-brand` 的 `febcd38` 创建。本功能尚未部署 ECS，也未操作真实 Ozon 发运。

## 订单页操作

1. 沿用「全部店铺 → 等待发货 → 物流方式 OGL → 已打印」联合筛选。勾选实际订单，支持保留跨页选择，然后点击「创建 OGL 发运批次」。
2. 首次使用时，由本企业负责人或管理员选择本企业默认发运店铺。同企业共用配置，以店铺 ID 保存；新批次保存创建店铺快照。没有按店名硬编码自动选择。
3. 服务端预览再次核对当前企业、原店铺、OGL、等待发货、已打印和活动批次归属。拒绝的订单逐项说明原因；不根据当前页猜测实际选择数量。
4. 输入实际货位数，例如 100 个已贴小面单的小包装入 3 个大袋，填写 3。保存内部批次不会标记已发运。可把订单分配到货位 1～3；未分配时显示「货位未记录」，不推测装袋位置。
5. 在批次详情查询默认店铺当前可用配送方式及日期，创建官方发运。系统核对官方实际收录的货件，再确认实际货位数量。下载货位标签 PDF 和交接条码 PNG；二者是不同文件。拣货单 PDF 不在本次范围内。
6. 商品实际寄出、送交或交给取件人员后，选择成员并点击「标记已发运」。仅生成官方单或打印标签不会自动交运。
7. 「OGL 发运批次」保留原批次成员、货位、物流汇总和操作历史。可筛选待交运、未上网、物流待更新、异常及已撤回成员，并按来源店铺刷新物流。

## 数据与状态边界

新增表为 `ogl_dispatch_settings`、`ogl_dispatch_batches`、`ogl_dispatch_members`、`ogl_dispatch_official_locks`、`ogl_dispatch_events`。各表显式保存企业 ID，默认企业的历史 NULL 店铺也必须通过当前企业和原店铺验证。

- 订单 `status/tracking_stage/logistics_status` 继续保存 Ozon 原始信息。OGL 实际交运记录派生 `display_status=ogl_dispatched`，界面显示「已发运」，悬浮提示「运往集运仓」。
- 只有有效、未撤回且已实际交运的 OGL 成员进入该标签页。已上网、签收、取消、退回或争议等平台状态优先，避免历史交运盖住后续状态。
- 非 OGL 订单没有新成员记录，沿用现有状态、打印及发货规则。订单原店铺、SKU、财务归属不变。
- 活动成员唯一约束与创建请求幂等键阻止重复组批；撤回保留旧成员和原因，再加入新批次会产生新成员记录。
- 已实际交运的数据同时用于库存和采购覆盖的运输证据，避免仍按待发订单占用实物库存；这些操作不额外生成一次出库，也不修改冻结的利润公式。
- 普通订单同步后，批次详情直接读取最新平台状态。只有取得交运之后的可靠物流，才计入「同步未上网」。刷新失败、旧数据与确认未上网分开显示；不自动认定丢件。
- 其他成员已上网、少数成员尚未上网时，可在原批次定位并标异常。异常保留处理历史；批次结束不等于所有订单已签收。

## 撤回与官方不一致

确认缺货、漏装或实际未发走时，填写原因撤回。订单恢复等待发货，保留小面单打印记录和原批次历史；不自动补库存、不改写平台物流。

平台已揽收、进入运输、取消或状态变化时，普通撤回会被阻止。订单仍在官方清单里时，先在 Ozon 后台移出或取消官方发运，再点击核对官方状态，确认已移出后才允许本地撤回。当前不提供猜测性的官方取消/回退接口。

创建、确认超时或断网时保留「待核实」。有官方编号时回读清单；创建结果未知时可填写在默认店铺后台查到的编号核对。同一企业、默认店铺及配送方式存在未核实操作时，不允许另一批次绕过防重再次建单。并发结果通过操作令牌核对，避免后来的同步覆盖正在执行的请求。

## 多店混装与已知接口边界

用户已向物流商确认多店铺小包可以物理混装。本地批次支持多店来源，一个默认店铺创建一份官方发运并填写整个批次的实际货位数。

用户已明确接受：跨店订单与批次／货位的对应关系保存在 ERP 中，不要求这些关系同时出现在 Ozon 官方后台。

**尚未验证默认店铺授权能否把其他店铺货件写进同一官方发运。** 当前实现只向默认店铺授权提交该店自己的 `posting_number`，逐项检查 `set-postings` 结果并回读精确清单；其他店铺成员明确显示为「仅本地混装关联，跨店 API 收录待验证」。不得把它报告成其他店铺已被官方收录。

默认店铺没有本店待发货件时，空发运后加入其他店货件也未验证，因此当前会阻止官方创建并保留内部批次。需要换默认店铺时，先处理旧批次，使用新设置重新组批，不改写历史批次创建店铺。

同一个默认店铺的成员必须匹配所选配送方式 ID；不同仓库／配送方式须分批。外店的配送方式 ID 可能属于店铺独立命名空间，不强制等于默认店铺 ID；它们不会被冒用默认授权提交。

## 本轮核实的官方接口

2026-10-22 直接读取官方文档页面核实：

| 操作 | 官方接口与必要条件 |
| --- | --- |
| 查询配送方式 | `/v2/carriage/delivery/list`；支持游标；`methods[].carriages[]` 中 `id=0` 且 `available_actions` 含 `create` 才能建单；`departure_date`、`has_entrusted_acceptance` 位于 method 层 |
| 创建 | `/v1/carriage/create`；默认自动收录该配送方式下全部可发货件，初始 `new`；使用官方返回的完整日期时间 |
| 调整清单 | `/v1/carriage/set-postings`；仅 `new`，完整替换组成；响应逐货件 `result` 布尔值与 `error`，HTTP 200 不等于全部成功 |
| 回读组成 | `/v2/posting/fbs/act/get-postings`；请求 `{id}`，`result` 是完整货件数组，当前 schema 无分页 |
| 确认货位 | `/v1/carriage/approve`；成功示例 `{}`；只有启用信任验收时适用 `containers_count`，本货位流程因此要求 `has_entrusted_acceptance=true` |
| 查询官方单 | `/v1/carriage/get`；文档列 `sended/received/closed/cancelled`；其 `available_actions` 是文件与通行证动作，不能猜测含 `approve` |
| 取件联系 | `/v1/carriage/courier-contact/set`；只适用于 `pickup + ozon_outsourced`，电话必填，微信最多 50 字、备注最多 500 字 |
| 货位标签 | `/v2/posting/fbs/act/get-container-labels`；PDF，每货位标签按官方要求打印 3 份贴三面；实际货位数与打印份数分开 |
| 交接条码 | `/v2/posting/fbs/act/get-barcode`；PNG，与货位标签分别下载 |

文件客户端兼容原始 HTTP 字节、JSON base64 和可无损还原的二进制字符串封装；不把 JSON 错误当文件。变更请求不自动重试。未知官方状态阻止后续确认，保留人工核对入口。

官方确认后的配送方式、货位总数与本地批次必须一致。缺少核心回读字段时保持待核实，明确不一致时阻止下载有效标签及实际交运，避免把 4 货位的官方单误当本地 3 货位批次。

官方来源：[配送列表](https://docs.ozon.ru/api/seller/#operation/CarriageAPI_CarriageDeliveryListV2)、[创建](https://docs.ozon.ru/api/seller/#operation/CarriageAPI_CarriageCreate)、[确认](https://docs.ozon.ru/api/seller/#operation/CarriageAPI_CarriageApprove)、[详情](https://docs.ozon.ru/api/seller/#operation/CarriageGet)、[取件联系人](https://docs.ozon.ru/api/seller/#operation/CarriageCourierContactSet)、[货位标签](https://docs.ozon.ru/api/seller/#operation/PostingAPI_PostingFBSActGetContainerLabels)、[发运条码](https://docs.ozon.ru/api/seller/#operation/PostingAPI_PostingFBSGetBarcode)。

## 自动验证与后续验收

服务启动会在库存预热之前创建新表；初始化脚本也包含同一 schema。部署时应先完成数据库备份、构建及新表检查，再接流量。单独运行依赖新运输证据的维护脚本前，也必须先确保新表已创建。

无需真实 Ozon 写入的检查：

```powershell
npm run check:encoding
npm run check:sql-bindings
npm run build:frontend
node --test test/ogl-carriage-client.test.js test/ogl-dispatch-routes.test.js test/ogl-dispatch-frontend.test.js test/order-cancellation-inventory.test.js test/inventory-product-balance.test.js
```

真实 MySQL 隔离测试要求自行准备 `skip_networking=1` 的独立命名管道实例，仅创建和删除随机测试数据库，不使用应用数据库或业务凭据：

```powershell
$env:TENANT_TEST_MYSQL_SOCKET='\\.\pipe\<独立测试实例名>'
node --test --test-concurrency=1 test/ogl-dispatch.test.js test/ogl-dispatch-state.test.js test/tenant-orders-mysql.test.js
```

页面已在本地 8788 的纯内存 mock 中验证联合筛选、双店预览、3 货位、分配、官方结果展示、标签入口、实际交运及原因撤回。mock 不证明真实 Ozon 已接收请求。

最终定向检查共 113 项通过、0 失败、0 跳过，包含本功能专项、真实隔离 MySQL、企业订单、库存、取消、状态和前端缓存回归；前端构建、编码及 SQL 绑定检查通过。

后续本地业务验收入口：`http://localhost:8788/admin.html#/orders`。先用企业测试数据检查默认店铺权限、未打印／非 OGL／非待发／重复批次拒绝、异常与历史。再用少量准备实际发货的默认店铺订单联调：查询可用槽位 → 创建 → 回读清单 → 核对货位数 → 确认 → 检查下载的真实标签和条码 → 实际交运 → 刷新物流。确认其他待发订单未被误收录。

未来第二家店铺出现 OGL 订单后，另行安排跨店 API 验证，记录逐项响应与回读清单；得到证据后再开放外店货件提交，不以本地批次成功或物流商混装许可替代验证。

扩展回归发现 `order-procurement-coverage.test.js` 有 4 个现有夹具失败、`orders-loading-performance.test.js` 有 4 个现有夹具失败；均已在原始 release `febcd38` 源码复现。本功能专项和企业订单／库存回归另行执行，不把未修复的既有失败表述为全量测试通过。

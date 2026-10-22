# OGL 发运实现与验证

更新时间：2026-10-22（北京时间）。实现分支 `codex/ogl-dispatch-workflow` 从 `febcd38` 创建；`71e2692` 及其前置发运批次实现已与当前 release 的企业隔离、AI 修复和 OGL 交接状态修复一并审查合并。实际部署提交以 `/release.json` 为准；本轮验收不创建、确认或取消真实 Ozon 发运。

## release 合并与企业隔离补充

- `acceptance_in_progress` / `posting_acceptance_in_progress` 属于已备货后的交接状态。订单页统一归入等待发货，保留实际平台状态、打印记录；不重复备货、不自动生成发运记录。已有真实交接/运输/签收/取消证据优先于旧状态。详见 [订单状态核验](order-postings.md#ogl-acceptance-after-preparation)。
- 官方申请、转运单号、标签及分页的每个外部请求前后都重新核验当前企业成员、岗位、订阅和原店铺授权。企业默认店铺变更时丢弃旧的只读查询；内部批次沿用创建时保存的店铺。权限撤销后禁止返回文件、继续下一页或执行后续官方写入，写请求仍不自动重试。
- `migrate-ogl-dispatch-schema.mjs` 默认只读，必须指定数据库和管理员 socket；apply 仅创建缺失的新表，不猜归属、不更改旧行。已存在但缺列、归属可空、有全局自然唯一键、前缀/隐藏/非唯一键或错误主键、自增身份的表会阻止发布，等待明确审查。
- ECS 流程先完整备份，再运行新表预演和 apply，然后才运行依赖交运证据的库存/采购维护与候选服务检查；即使跳过普通维护也执行此步骤。就绪检查验证 5 张表的显式企业归属、InnoDB、完整自然键和批次/成员/事件主键。
- 新企业首次使用需由本企业负责人或管理员选择默认发运店铺；不根据名称自动指定、不复制默认企业配置。已有申请和服务器监控只读取本企业授权原店铺的官方单，关联采用企业、原店铺、官方申请号自然键；关联本身不标记实际交运。

最终合并验证：OGL、订单、库存运输证据、会话缓存及撤权测试组 190/190 通过；新表迁移、完整 HTTP 企业隔离、自然键就绪和发布流程测试组 62/62 通过，均无跳过。另以亮色/暗色 mock 页面验证等待发货、打印、批次及承运商运单号展示；真实 Ozon 建单和确认仍须按下述业务验收联调，不将 mock 成功表述为官方已接收。

## 订单页操作

1. 沿用「全部店铺 → 等待发货 → 物流方式 OGL → 已打印」联合筛选。勾选实际订单，支持保留跨页选择，然后点击「创建 OGL 发运批次」。
2. 首次使用时，由本企业负责人或管理员选择本企业默认发运店铺。同企业共用配置，以店铺 ID 保存；新批次保存创建店铺快照。没有按店名硬编码自动选择。
3. 服务端预览再次核对当前企业、原店铺、OGL、等待发货、已打印和活动批次归属。拒绝的订单逐项说明原因；不根据当前页猜测实际选择数量。
4. 输入实际货位数，例如 100 个已贴小面单的小包装入 3 个大袋，填写 3。保存内部批次不会标记已发运。可把订单分配到货位 1～3；未分配时显示「货位未记录」，不推测装袋位置。
5. 在批次详情查询默认店铺当前可用配送方式及日期，创建官方发运。系统核对官方实际收录的货件，再确认实际货位数量。下载货位标签 PDF 和交接条码 PNG；二者是不同文件。拣货单 PDF 不在本次范围内。
6. 商品实际寄出、送交或交给取件人员后，选择成员并点击「标记已发运」。每次登记都重新读取原店官方清单、配送方式和货位数，包括历史已核实批次；发生变化先保存待核对／不一致结果并拒绝物理写入，不能沿用旧的 approved 标记或客户端自报核验结果。仅生成官方单或打印标签不会自动交运。
7. 「OGL 发运批次」保留原批次成员、货位、物流汇总和操作历史。可筛选待交运、未上网、物流待更新、异常及已撤回成员，并按来源店铺刷新物流。

## 数据与状态边界

新增表为 `ogl_dispatch_settings`、`ogl_dispatch_batches`、`ogl_dispatch_members`、`ogl_dispatch_official_locks`、`ogl_dispatch_events`。各表显式保存企业 ID，默认企业的历史 NULL 店铺也必须通过当前企业和原店铺验证。

- 订单 `status/tracking_stage/logistics_status` 继续保存 Ozon 原始信息。有效官方申请或真实交运记录派生 `display_status=ogl_dispatched`，兼容原统计键；界面统一称「发运跟踪」，逐行区分「已申请·待交接」与「已实际交运」。`ogl_dispatch.tracking/applied` 只表示申请跟踪；`dispatched/dispatched_at` 严格表示操作员显式登记的实物交运。
- 已上网、签收、取消、退回或争议等真实订单状态始终优先。申请的 `formed/received/closed` 不能代替订单轨迹，也不能将订单倒退为待发或冒充运输。
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

### 后台已建单的真实只读核验

同日通过默认企业所属店铺授权，只读查询了后台已创建的 OGL 发运。`delivery/list` 能返回 `carriages.id > 0` 的真实已有单，`get` 与 `get-postings` 均可取得其详情及组成，货件可与 ERP 原店铺订单匹配。

该 OGL 样本的 `get.status` 和列表状态均为 `formed`；`get.available_actions` 返回 `cancel`、`get_label_containers`、`get_label_containers_small`。这与通用文档列出的状态及文件操作枚举不同。只读观察不能证明所有 OGL 状态映射，不能直接将其当作运输证据，也不应未经核验就对它调用 approve。

顶部 OGL 下拉提供创建、已申请和发运记录。已申请默认近 7 个北京日，可选择月份或不超过 31 天的起止日期；内部发运记录以批次创建时间匹配同一北京日范围。`delivery/list.filter.departure_date` 逐日传 `YYYY-MM-DD`，每日至多完整读取 10 页，不返回被截断的成功清单；合并结果超过 100 单时提示缩小范围。排除 `id=0` 建单占位，按申请编号去重；每单以 `get` 补官方 `created_at`、货位数与状态，详情以 `get-postings` 精确匹配原授权店铺的本地订单。单日日期没有具体时刻时不推测创建时间；未知数值显示待获取。

`formed` 显示为「已生成」、`received` 显示为「验收中」，保留原始官方状态。`POST /api/ogl-dispatch/discover` 才持久关联：复用 5 张既有表，批次 `official_status=observed/status=preparing`、来源 `official_result.source=official_discovery`；本店已同步且识别为 OGL 的订单才成为成员，其他店、其他企业、未同步货件仅在详情显示未匹配。活动唯一键冲突保留原批次，显示人工核对提示，不抢占订单。官方移除或取消时只释放未实际交运的自动关联，保留实物交运和手工撤回历史。重启和并发发现不重复建批，也不创建、批准或修改 Ozon 官方单。

发现后默认只能跟踪、查看和下载官方已开放文件。要登记实物交运，须先显式「核对并接管跟踪」：`action=official-adopt` 重新读取原店官方清单，要求本店清单完全匹配、实际货位数已知且与操作员输入一致，保存 `official_result.local_management` 及真实操作员事件，仍保持 `official_status=observed`，不伪造已批准。随后单独选择实际发走的订单并确认「标记实际交运」；服务端再次回读官方组成和数量、核对成员快照与真实运输终态，才写 `dispatched_at/by`。接管、标签读取与官方 `received` 均不产生实物证据。

服务器每 5 分钟运行有界监控：仅内部枚举已保存设置，按 `settings.updated_by` 恢复真实企业成员，首轮回查 7 日、后续回查 2 日，并轮询已关联但未结束的原店批次和订单轨迹。单轮至多 20 个企业、每企业 20 个历史批次，游标轮转避免失败批次永久阻塞其他批次。每次请求和返回前重新检查成员、岗位、订阅与原店授权，缺少有效操作员或授权即暂停并在 bootstrap 返回说明；绝不合成平台或默认企业身份。默认店变更只影响新发现，旧批次继续按原店跟踪。监控只使用官方读取接口，不能代替人工交运确认。

监控使用独立 `ogl` 调度分类和 `high` 优先级，仍低于 critical 订单同步，避免被同类订单任务与候选队列截断长期挤出；允许一次有界补跑，读取范围仍受上述天数与数量限制。首轮前台让步保留最早到期锚点，至少 5 分钟后才可越过前台空闲等待，只有取得通道并实际开始监控才清除锚点；数据库连接池压力和独立后台通道仍会阻止执行。未取得通道时记录跳过并在 30 秒后重试，不能误记为监控成功。其他定时任务的调度策略和通用候选算法保持原样。

只读接口：`GET /api/ogl-dispatch/official-carriages?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD`（兼容单日 `date`）、`GET /api/ogl-dispatch/official-carriage?id=...&date=YYYY-MM-DD`。GET 保持只读；页面打开或查询已有申请时显式发送 discover POST。均使用当前企业配置的默认店铺，在网络返回后重新检查成员、订阅与默认店铺，避免查询期间切换身份或店铺而展示旧数据。

### 申请号、承运商运单号与货位标签

`carriage_id` 是 Ozon 申请号，与圆通 `YT...` 承运商运单号分开显示。两个真实 OGL 样本的 `get` 均未提供主运单号字段，但官方 `/v2/posting/fbs/act/get-container-labels` PDF 含清晰的圆通号码，重复印在标签四周及条码下方；已通过提取与视觉阅读互相核对。

详情先显示申请和订单，再异步调用 `GET /api/ogl-dispatch/official-carriage-tracking?id=...&date=YYYY-MM-DD` 读取标签中的承运商运单号，注明来源「官方货位标签」。PDF 文本识别使用现有 `pdf-lib`，支持 ToUnicode 字体映射，不依赖本机 Python、外部命令、OCR 服务或新增运行时依赖。文件获取或解析失败单独显示待获取／重试，不影响已有申请详情。

- 多页重复同一 `YT...` 时主号码去重展示，不当成多个主运单；出现多个不同号码时全部列出，保留主子母关系待核对，不任取第一个作为主单。
- 货位数以官方详情 `containers_count` 为准；PDF 页数、重复印刷次数和实际货位数分别记录。标签明细只显示页序，不据此推测官方货位 ID 或订单装袋关系。
- 不把单个订单小包的 `tracking_number` 当作整批货位的承运商主单号；未识别出可信号码时显示待获取，不拼接或生成号码。
- 单独解析请求结果仅短时内存缓存，按企业、默认店铺、申请、日期和当前货位数隔离；命中缓存仍复查授权。自动发现只持久保存经过标签解析确认的承运商及运单标识，来源固定 `official_container_label`；没有可信结果则待获取，不保存 PDF、联系信息或整段标签文本，也不以读取标签动作标记实际交运。

实际样本 PDF 页面约为 100×70 毫米，与通用文档常见的标签尺寸不同；打印应保留官方文件实际尺寸，不按通用尺寸强制缩放。

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

后台已有申请与标签运单号增量完成后，再次整组执行 130 项定向检查，全部通过且无跳过。真实两份官方 PDF 由新解析器提取并经视觉核对；今日／昨日页面分别在脱敏 mock 中验证。补充日期精度修正后，31 项前端、解析及路由检查通过；日期字段仅返回日历日时不展示推测时刻。前端构建、编码及 SQL 绑定检查再次通过。所有页面验证仅运行本地 8788 的临时 mock，已停止；未部署 ECS、未重启业务服务，未创建、修改或取消真实官方申请。

后续本地业务验收入口：`http://localhost:8788/admin.html#/orders`。先用企业测试数据检查默认店铺权限、未打印／非 OGL／非待发／重复批次拒绝、异常与历史。再用少量准备实际发货的默认店铺订单联调：查询可用槽位 → 创建 → 回读清单 → 核对货位数 → 确认 → 检查下载的真实标签和条码 → 实际交运 → 刷新物流。确认其他待发订单未被误收录。

未来第二家店铺出现 OGL 订单后，另行安排跨店 API 验证，记录逐项响应与回读清单；得到证据后再开放外店货件提交，不以本地批次成功或物流商混装许可替代验证。

扩展回归发现 `order-procurement-coverage.test.js` 有 4 个现有夹具失败、`orders-loading-performance.test.js` 有 4 个现有夹具失败；均已在原始 release `febcd38` 源码复现。本功能专项和企业订单／库存回归另行执行，不把未修复的既有失败表述为全量测试通过。

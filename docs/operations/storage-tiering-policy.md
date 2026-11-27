# 存储分层与热缓存取舍

记录日期：2026-11-27。用户指示：读取频繁的数据要权衡存放位置；不常读取但有价值、值得留存的数据适合长期保存到 OSS。

本文件记录长期取舍原则，依据本次核对的 `b90d41d5` 源码，不代表所有生产开关已经启用。它不新增后台任务、配置开关、自动冷热转换或删除策略，也不属于此前已批准部署内容。生产变更仍遵守 `AGENTS.md`。

## 判断依据

同时考虑访问频率、实际传输字节、留存与恢复价值、是否唯一副本、可接受恢复时间，以及磁盘、内存、CPU 和公网费用。对象年龄只是一项线索，不能单独决定转冷或删除。

| 数据 | 默认取舍 | 当前代码依据 |
| --- | --- | --- |
| 订单、库存、成本等事务数据与高频业务读 | 保留 MySQL 权威记录；按企业与权限使用有界读缓存或快照，不为省磁盘整体迁往 OSS。 | [首页 DB 快照](../../src/services/mysql-cutover.js#L29872)、[通知查询](../../src/services/system-notifications.js#L71) |
| 大型库存需求读模型 | 允许可恢复的 OSS 正文加 DB 引用，但热读应复用内存结果。当前仅显式开关开启且达到 256KiB 才分流；不能理解为每次轮询都下载 OSS。 | [大 JSON 边界](../../src/services/scoped-json-object.js#L7)、[按企业加载复用](../../src/services/inventory-demand-snapshot.js#L37) |
| 列表缩略图、可再生参考图 | 优先浏览器、内存和本地有界缓存；采用缩略图、请求合并及失效机制。展示派生图不能替换保存、AI 输入、预览或刊登原图。 | [缩略图服务](../../src/services/public-image-thumbnail.js#L23)、[浏览器缓存](../../frontend/admin/utils/thumbnail-batch-loader.js#L2)、[AI 参考图缓存](../../src/server/services/ai/aiWorkflowService.js#L40) |
| 活跃原图、生成输入、公开刊登图与正在使用的视频 | OSS 标准型保留可靠原件，本地保留工作热缓存；发布地址保持外部实时可读。不能因为文件大或较旧就统一转冷。 | [持久副本与恢复](../../src/services/media-cache-files.js#L105)、[公开原件缓存头](../../src/services/object-storage.js#L278)、[视频复用](../../src/services/asset-variant-engine.js#L3165) |
| 低频、高价值历史素材、备份、binlog、原文及恢复清单 | 作为长期归档候选；先验证引用、恢复链、完整性、恢复时限及总成本，再评估具体存储类别。归档候选不等于允许删除。 | [日志归档](../../src/services/binlog-archive.js#L26)、[私有原文恢复](../../src/services/private-json-archive.js#L14)、[备份保留](../../scripts/lib/release-backup-retention.mjs#L101) |

## 必须保留的边界

- OSS 不只适合冷数据。标准型支持频繁实时读取；低频访问和归档类别存在取回费用、最低保存期或恢复等待，不能按年龄盲目转 IA/Archive。参见 [OSS 存储类型](https://www.alibabacloud.com/help/en/oss/user-guide/overview-53/)和[存储计费](https://www.alibabacloud.com/help/en/oss/storage-fees)。
- 将大原图移到 ECS 或由 ECS 中转不等于免费。EIP 按流量计费时公网出站收费，按带宽计费时仍占带宽；应比较实际账单与传输量。参见 [EIP 计费](https://www.alibabacloud.com/help/en/eip/billing-overview)。
- 本地缓存回收只可处理已有完整、核验通过且能恢复的持久副本；活动任务、未知引用、损坏映射及唯一副本必须保留。[现有回收保护](../../src/services/automatic-media-cache.js#L23)不能为提高命中率或释放空间而放宽。
- `data/ai-credit-results` 是 AI 扣费与重试恢复资料，不是普通临时缓存。其 [存储](../../src/services/ai-credit-result-store.js#L39)与 [SQL/AI 结果成对备份](../../scripts/lib/release-backup-retention.mjs#L101)受保护；清理 AI 历史列表不代表可以删除这些结果。
- 原文归档、恢复映射、受保护备份、财务历史及连续 binlog 恢复链必须保留。上传后完整读回验真属于恢复保障，不能用 HEAD 或对象名代替。
- 私有权限判断必须新鲜且保持企业隔离；缓存命中不能绕过授权。不可为了缓存共享而将私有对象公开。

## 调整前先测量

按用途记录 HIT/MISS、实际请求与响应字节、缓存写入因预算被拒次数、重复恢复次数、对象访问频率及磁盘余量，区分浏览器、服务器内网读取和外部平台读取。

当前缩略图磁盘缓存有容量上限；[写入器满额会拒绝新缓存](../../src/services/image-read-cache.js#L66)，并不等于持续保持高命中率。先确认是否存在频繁重复派生或恢复，再决定有界 LRU、容量或保留窗口；同时保留磁盘预算、权限失效和恢复校验。

任何后续冷热迁移、容量调整、生命周期规则或物理清理，都应单独准备具体范围、成本与恢复验证。本文件不授权自动转换存储类别、删除 OSS 对象、迁走唯一副本或立即新增调度任务。

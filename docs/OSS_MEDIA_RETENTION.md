# OSS 媒体目录与保留策略

系统按用途把媒体写入不同的 OSS 前缀，生命周期规则必须按前缀配置，不能对整个 Bucket 的当前版本统一删除。

| OSS 前缀 | 数据用途 | 当前版本保留时间 |
| --- | --- | --- |
| `collector-media/` | 采集箱和外部商品同步回来的原始图片 | 永久 |
| `listing-media/` | 草稿最终采用的图片、最终上架图片和成品视频 | 永久 |
| `ai-unused/` | AI 已生成但未被草稿采用的图片 | 30 天 |
| `video-source/` | 视频制作源文件、参考视频 | 30 天 |
| `temporary/` | 上传中转和其他临时文件 | 3 天 |

## 阿里云 OSS 生命周期规则

保留现有 `temporary/` 规则，并另外创建两条规则：

1. `cleanup-ai-unused`：前缀 `ai-unused/`，当前版本最后修改 30 天后删除。
2. `cleanup-video-source`：前缀 `video-source/`，当前版本最后修改 30 天后删除。

两个规则都可以把历史版本设为 30 天删除、碎片设为 3 天删除。不要为 `collector-media/` 或 `listing-media/` 配置当前版本删除规则。

Bucket 采用“公共读、禁止公共写”；上传密钥仅保存在服务端环境变量中，浏览器和插件不得保存 AccessKey Secret。

## 素材复用规则

- 新采集数据写入正式业务表前，必须先把主图、详情图、变体图和视频归档到 `collector-media/`。
- 正式采集记录只保存本系统管理的 OSS URL；OSS 未启用或归档失败时阻止该商品写库，并由同步结果返回明确错误。
- 外部来源 URL 只允许在本次归档任务的内存上下文中临时存在，不作为正式业务图片地址持久化。
- 裂变草稿沿用已有详情图时，直接保存原 OSS 地址，不重新下载、加水印、转码或上传副本。
- 新主图、确实经过编辑的图片和成品视频才创建新的内容寻址对象。
- 尾图模板保存在 `listing-media/` 并永久保留；多个店铺、草稿和商品引用同一个模板地址。
- 历史外部地址和本地地址在迁移完成前保持兼容，迁移时按文件哈希归并为一个 OSS 对象。

## ECS 本地副本保留

- `uploads/ai-generated` 和 `uploads/shop-variants` 默认保留 7 天，供生成过程、预览和短期重试使用。
- 只有当内容 SHA-256 对应的 `ai-unused/` 或 `listing-media/` OSS 对象存在，且 OSS `Content-Length` 与本地文件大小一致时，才允许删除本地副本。
- 清理器默认 dry-run；写入模式仍必须小批、可重跑，并输出本地路径、OSS 对象 key、URL、哈希和字节数清单。
- OSS 对象缺失、大小不一致、校验超时或鉴权失败时，本地文件必须保留。

```bash
npm run cleanup:verified-local-media
npm run cleanup:verified-local-media:write -- --days 7 --limit 200
```

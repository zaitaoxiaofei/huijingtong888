# AI裂变工作台流程说明

本文档整理当前 `/asset-variant-center/wizard` 三步式 AI 裂变工作台的产品流程、代码链路、视频处理规则和代码巡检结果。项目内还有一个较早的多店铺素材裂变中心 `/asset-variant-center`，两者共用部分后端素材生成能力，但当前运营主流程以本文的三步工作台为准。

## 1. 入口和页面

- 导航入口：`AI裂变`，路由 `/asset-variant-center/wizard`。
- 页面文件：`frontend/admin/views/listing/AiOptimizationWorkbenchV2.vue`。
- 复用页面模式：
  - `asset-variant-center-wizard` / `asset-variant-center-create`：AI裂变工作台。
  - `ai-optimization-workbench-v2`：AI优化模式，当前路由实际指向提示词库页面，历史命名需注意。
- 常见来源：
  - 采集箱：`CollectorBoxView.vue` 通过 `openAiWorkbench(row, "variant")` 进入。
  - 在线商品：`OnlineProductsView.vue` 通过 AI裂变按钮进入。
  - 选品池：`SelectionView.vue` 可进入裂变或发布队列。
  - 草稿/发布记录：`ListingPublishRecordsView.vue` 可回到 AI裂变继续优化。

货号规则：

- 新裂变草稿统一使用 `VAR-*` 前缀，不再使用 `AI-*`。
- 车型目标存在时使用 `VAR-车型-*`；后端兜底使用 `VAR-时间戳`。
- 货号不负责决定开发类型，裂变类型由结构化字段 `development_type = fission` 表达。
- 历史 `AI-*` 货号不批量改名，避免破坏 Ozon 商品、订单、库存和本地映射关系。

## 2. 三步用户流程

### 第一步：选择商品

作用：选择母商品，导入其基础数据和上架模板快照。

主要数据：
- `products`：当前导入商品列表。
- `selectedIds`：被选择的母商品。
- `currentSourceBatchId`：隔离一次导入批次，避免不同入口的数据混在一起。

商品归一化逻辑在 `normalizeProduct()`：
- 从采集箱、在线商品、草稿、发布记录等不同 payload 中提取标题、类目、图片、视频、标签、材质、颜色、尺寸、重量等。
- 通过 `extractTemplateSnapshotFromPayloads()` 尽量保留原上架模板。
- 视频来源会进入 `product.videoUrls`，用于原视频展示，不直接当作新裂变视频。

### 第二步：确认裂变

作用：确定裂变类型、裂变目标和提示词策略。

核心对象：
- `variantPlan.type`：裂变类型，如车型、尺寸、颜色、场景等。
- `variantPlan.targetsText`：用户输入的裂变目标。
- `buildVariantStrategy()`：把输入目标解析成结构化目标。
- `buildVariantResult(product, target, index)`：为每个母商品和目标生成一个工作行。

策略来源：
- 页面内置类目策略，如门槛条、后备箱垫、方向盘套等。
- 提示词模板库：可按字段配置主图、详情图、标题、标签、描述、副文本。
- `ProductDNA`/模板变量工具：`frontend/admin/utils/aiVariantWorkbench/` 负责把产品事实、未知事实和安全规则组装进提示词。

### 第三步：生成结果

作用：按勾选字段批量生成并审核，随后保存草稿或进入上架预览。

字段选择：
- 顶部 `生成内容` 可勾选 `主图 / 详情图 / 标题 / 标签 / 描述 / 副文本 / 视频`。
- `generationFields` 记录当前勾选字段。
- 裂变模式下，文本和图片字段主要来自已配置的提示词；视频是额外开关。

生成主流程：
1. `generate()` 校验商品、字段和裂变目标。
2. `ensureVariantQueueSynced()` 保证结果队列与当前目标同步。
3. `runBatchOptimization(rows)` 批量执行。
4. 普通字段先执行：
   - 文本字段：`regenerateText()`。
   - 图片字段：`regenerateImage()`。
   - 当前未接入真实生成的字段使用本地预览结果。
5. 如果勾选视频，普通字段完成后再执行 `generateVideo(row)`，确保视频使用最终主图。

并发：
- 普通字段通过 `runLimited(..., 3)` 控制并发。
- 视频通过 `runLimited(..., 2)` 控制并发。

## 3. 视频生成和上架规则

### 生成入口

前端函数：`generateVideo(row)`。

请求接口：
```text
POST /api/asset-variant-engine/generate-video
```

请求参数：
- `imageUrl`：优先使用 `row.generatedMainImageUrl`，否则使用母商品主图。
- `title` / `productName` / `categoryName`：用于视频素材命名和生成上下文。
- `sourceId`：用于生成批次和缓存识别。

后端函数：`generateAssetVariantVideoFromImage()`。

关键约束：
- 当前接口要求 `imageUrl` 能解析成本地素材路径。
- 后端用 `ensureAssetVariantVideoFromImages()` 生成 mp4。
- 返回值经 `normalizeGeneratedVideoForResponse()` 标准化。

### 前端展示

结果表格：
- 勾选视频后，表格会在 `描述` 和 `状态` 之间显示 `视频` 列。
- 生成前显示 `待生成视频`。
- 生成中显示 `视频生成中`。
- 生成后显示视频缩略区域，点击打开视频预览弹窗。

详情抽屉：
- `图片与视频` 区域支持手动 `主图生成视频`、`上传视频`、`预览`。

### 写入上架草稿

当前三步工作台按运营要求处理：
- 必须使用后端返回的 `publishUrl` 作为上架素材地址。
- 同一份 mp4 同时写入：
  - `video_urls`
  - `video_cover_urls`
- 这样保证视频和视频封面都是视频格式，并且 Ozon 能访问同一份公网文件。

实现点：
- `rowPublishableVideoUrl(row)` 从 `row.video.publishUrl` 优先取公网地址。
- `applyRowVideoToVariant(variant, row)` 把同一个视频地址写入 `video_urls` 和 `video_cover_urls`。
- `fallbackListingTemplatePayload()` 和 `mergeTemplateWithAiResult()` 都会调用 `applyRowVideoToVariant()`。

### 与采集箱/上架页一键生成视频的关系

采集箱进入编辑上架后的 SKU 视频逻辑在 `ListingAutomationView.vue`：
- `generateVariantMedia(row, field)` 调用 `/api/listing/variant-media/generate`。
- 成功后同样执行：
  - `row.video_cover_urls = [videoUrl]`
  - `row.video_urls = [videoUrl]`

这与当前三步 AI裂变的视频写入策略保持一致。

## 4. 草稿、预览和发布链路

### 当前母草稿的变体权威（2026-11-11）

- AI 裂变工作台（`ai_variant_lab`）指定 `source_draft_id` 时，后端重新读取当前母草稿快照，即使请求携带了旧快照也不使用旧值。
- 当前快照显式保存的 `editable_payload.variants` 是完整 SKU 列表，包括空列表；不得按模板和快照的最大长度拼接，不得按行号继承旧 SKU 的颜色、属性或媒体。
- 只有快照缺少有效变体数组时，才兼容使用模板变体。初次继承和保存前的最终合并使用同一规则。
- 旧草稿自动修复模板引用时，同样保留当前快照的变体列表；不得让历史 `manual_facts` 恢复已删除行。
- 修复代码不会自动清理已经受污染的历史草稿或模板；历史修复需逐条核对，并保留当前生成主图及人工编辑。

### 目标车型标签回填（2026-11-12）

**确认的原因。** 裂变计划按目标品牌和车型产出 `title_ru`、`tags_ru`、`description_ru`，而草稿同时保留多种标签字段。旧回填只更新 `hashtags` 和公共属性，遗漏首 SKU 的 `main_tags`、`tags`、普通标签属性及动态属性。编辑器优先读取 `main_tags`，发布预览优先读取 `tags/main_tags`，因此生成记录正确也可能在编辑、保存和发布时继续使用母车型标签。

**为何以前可能正常。** 可追溯代码中，编辑器在 `c2087886`（2026-05-25）已采用上述读取优先级；裂变补丁在 `bf51dbfb`（2026-06-12）引入时就只写 `hashtags`。工作流产草稿在 `bfd7866b`（2026-11-06）和 `ceb0e1fb`（2026-11-07）开始同时写入多份 SKU 标签，暴露了旧同步遗漏。以上为北京时间的代码提交日期，不能据此认定具体上线时刻或把所有旧数据都判定为错误。

**修复边界。** 目标首 SKU 的 `main_tags`、`tags`、`hashtags`、普通属性 `23171` 以及动态属性的两种命名同步更新，包括选中值和显示文字。同步只作用于本次目标 SKU，保留其他 SKU、图片及人工填写的非标签属性；没有新的标签补丁时沿用既有标签，不因其他字段更新而清空。

**防回退验证。** 回归覆盖首轮保存、重新进入编辑器、再次保存和发布预览；生成的目标标签、SKU 主标签以及 Ozon 属性 `23171` 必须一致。数据修复与程序修复分开：历史草稿和上架记录不会在程序测试过程中自动改写，须在功能验收后另行审阅安排。

同轮检查还覆盖以下文案边界：

- 标题主字段与已有名称属性 `4180` 同步；描述 `4191` 的当前值、选中值和显示副本同步，不把旧别名作为当前文案。
- 修改目标车型时，空格、下划线和紧凑标签按完整车型边界替换，保留人工审核过的其他文字。生成端过滤明确源车型标签，同时保护 `H3/H30`、`CX-3/CX-30` 和完整目标车型的前缀关系。
- 自动富文本由当前目标、标题、描述和主图决定；准备缓存使用这组输入的完整签名，异步等待后复查。持续编辑超过重试上限时明确失败，不把旧内容标为完成。人工自定义布局、文字、详情图及非图片链接保留，仅替换首图及其重复图片引用。
- 批量编辑保留每稿自身的描述、富文本及图片；仅在操作员显式使用公共文案时同步共同值，不因首稿有值而隐式覆盖其他稿。

历史文案修复使用 `scripts/repair-reviewed-ai-fission-copy.mjs`，默认只读。清单必须逐条指定企业、草稿与模板关系、允许修改的文案路径及前后值；审计后生成行摘要和未改字段摘要，再显式 `--apply`。每批最多 50 稿，模板有其他草稿引用时拒绝修改模板。写入前保存私有备份，在事务中复核并检查实际结果；相同清单重复执行不再次改写。

该脚本不生成新文案、不调用收费 AI、不重建整份草稿，不修改 SKU、图片、价格、发布请求或 Ozon 线上商品。富文本仅允许已审核的文字修正，保留媒体、链接和布局。缺少明确来源、存在人工歧义或使用冻结内容的记录必须另行核对，不能靠批量套用生成明细覆盖。

### 裂变记录与图片持久化

- 裂变记录使用居中对话框展示，包含操作人员、北京时间、母商品、源车型、目标数量和任务状态。
- 图片生成接口返回结果后，后端必须先将图片物化到永久 `listing-media` 素材目录并登记素材记录，再把任务行标记为 `image_done`。
- 任务表保存永久图片 URL、预览 URL和原始 AI 临时文件 URL。重新登录、刷新或关闭页面后，从裂变记录恢复时直接读取永久图片。
- 旧任务详情首次打开时会尝试补物化尚未持久化的 AI 临时图片，并将永久地址回写到任务行。
- 保存草稿只负责形成可继续编辑、校验和提交 Ozon 的上架数据，不再承担 AI 图片保活职责。

保存草稿：
1. `openWriteback()` 打开回填弹窗。
2. `confirmListingDraftSave()` 批量保存。
3. `saveRowToListingDraft(row)`：
   - 若采集箱商品没有模板快照，先调用采集箱模板创建接口。
   - `buildListingTemplatePayload(row)` 生成模板 payload。
   - `POST /api/listing/templates` 保存模板。
   - `buildListingDraftPayload(row, template)` 生成草稿 payload。
   - `POST /api/listing/drafts` 保存草稿。

进入上架预览：
- `goListingPreview(row)` 会先确保草稿存在，再跳转到上架编辑/预览。

发布前媒体物化：
- `listing-automation.js` 的 `materializeAiOptimizationTemplateMedia()` 会把图片、视频、视频封面统一物化为可发布媒体。
- `normalizeVariantMediaForPublish()` 会把 `video_urls` 和 `video_cover_urls` 转为发布可用 URL。
- `validateListingTemplatePublishForShop()` 会校验本地 `/uploads` 类地址不能直接提交给 Ozon。

## 5. 旧多店铺素材裂变中心差异

旧中心页面：`frontend/admin/views/listing/ShopAssetVariantCenter.vue`。

后端主流程：
- `generateAssetVariants()` 批量生成素材包并写入 `asset_variants`。
- `importAssetVariantToListingAutomation()` 把素材包转成上架模板和草稿。
- `publishAssetVariantsToOzon()` 走导入、预检、提交 Ozon。

当前策略：
- `assetVariantVariantRow()` 会把生成视频同时写入 `video_urls` 和 `video_cover_urls`。
- 相关测试 `asset-variant-content-check.test.js` 已保护这个统一策略。
- 因此，三步 AI裂变工作台、采集箱上架页和旧多店铺素材中心都会复用同一份 mp4 作为视频和视频封面。

## 6. 巡检发现

### 已确认正常

- 三步工作台有明确的批次隔离：`currentSourceBatchId`、`pageDraftKey`、`sourceBatchId`。
- 视频生成顺序已调整为普通字段之后，能使用生成后的主图。
- 勾选视频后，当前结果表会显示视频列，不再只在隐藏旧卡片视图里显示。
- 上架草稿写入时，当前三步工作台会把同一份 mp4 同时写入 `video_urls` 和 `video_cover_urls`。
- 发布链路有公网 URL 校验，本地 `/uploads` 地址不会被直接提交给 Ozon。
- 编码检查通过，当前文档和代码保持 UTF-8。

### 本轮已修复

1. 视频生成失败状态不够准确
   - `generateVideo()` catch 分支已改为 `status: "failed"` 和 `label: "视频生成失败"`。
   - 表格不再把空 URL 误显示为已生成视频。

2. 上传视频缺少 `publishUrl` 字段归一
   - `handleVideoUpload()` 已显式保存 `publishUrl`。
   - 预览地址和上架地址分开记录，后续草稿写入优先使用公网地址。

3. 后端 AI裂变视频接口只接受本地可解析主图
   - `generateAssetVariantVideoFromImage()` 已支持远程图片。
   - 本地图片继续直接使用本地文件；远程图片会先读取并物化为 `video-source.jpg`，再生成 mp4。

4. 三步工作台与旧素材中心的视频封面策略不一致
   - 旧素材中心已改为同一份 mp4 同时写入 `video_urls` 和 `video_cover_urls`。
   - 相关测试已同步更新。

### 仍需关注

1. `confirmWriteback()` 仍是轻量状态回填
   - 真正保存草稿应走 `confirmListingDraftSave()` / `saveRowToListingDraft()`。
   - 如果弹窗里仍保留“覆盖草稿字段”等状态型选项，需确认是否会误导操作员。

## 7. 建议下一步

优先级建议：
1. 梳理 `confirmWriteback()` 弹窗文案和按钮语义，避免“只改状态”和“真实保存草稿”混淆。
2. 增加端到端验证：导入远程主图、勾选视频、生成、保存草稿、进入上架预览，确认视频和视频封面均可访问。

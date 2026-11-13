# 旧类目兼容

核对日期：2026-11-13。开发基线：`764fc282f5f40b403e08cc32ecb7e91ddd4ecd7b`。

## 当前契约

- [类目属性](https://docs.ozon.ru/api/seller/#operation/DescriptionCategoryAPI_GetAttributes)：使用 `/v1/description-category/attribute`，必须同时提供 `description_category_id` 和 `type_id`。
- [原商品属性](https://docs.ozon.ru/api/seller/#operation/ProductAPI_GetProductAttributesV4)：`/v4/product/info/attributes` 可按 `product_id`、`offer_id` 或 `sku` 查询。默认 `visibility=ALL` 不包含归档商品。
- 本批移除旧属性读取分支 `/v3/category/attribute`；不据此宣称其官方退役日期。

## 兼容行为

1. 完整的新类目与类型优先使用，包括用户重新选择的新字段。
2. 旧 `description_category_id:type_id` 组合编号可精确拆分，属性和属性值查询使用同一组字段；与部分新字段冲突时阻止操作。
3. 只有旧单一 `category_id` 时，不按名称或类目树顺序推测。存在原商品引用时，只读取所选企业、店铺的原商品，返回商品必须唯一且与所有已提供编号一致。
4. 原商品不存在、归档未返回、字段缺失、匹配歧义或部分新字段冲突时，提示到「商品上架／模板编辑」重新选择类目与商品类型。
5. 模板刷新成功后沿原有保存流程写入已核对的新字段；不批量改写历史模板。读取或核对失败时不以空属性继续应用模板。

原商品查找只允许当前企业启用的 Ozon 店铺；未指定店铺且缓存匹配多个店铺时要求选择。请求前后重新检查成员权限、店铺归属、启用状态及授权是否变化。官方错误和冷缓存同步错误保留，不伪装成成功空列表。

## 验证与发布边界

- 185 项客户端及相关上架测试通过。
- 20 项隔离 MySQL 测试通过，覆盖企业／店铺隔离、重复匹配、换钥与撤权、缓存和模板刷新。
- 前端构建、UTF-8 检查、SQL 参数检查通过。
- 本批无需表结构迁移或插件更新。尚未发布或部署，未进行生产旧模板恢复验收。

export const PRODUCT_IDENTITY_FIELDS = [
  ['id', '关联商品 ID'], ['code', '原 P 编码'], ['inventory_number', '库存编号'], ['inventory_number_version', '编号规则版本'],
  ['name', '商品名称'], ['inventory_category', '核心品名'], ['vehicle_brand', '绑定品牌'], ['fitment_type', '适配类型'],
  ['vehicle_model', '绑定型号'], ['vehicle_models_json', '已绑定型号列表'], ['accessory_name', '配件属性'], ['color', '颜色'],
  ['material', '材质'], ['surface_process', '表面工艺'], ['product_quantity', '产品规格数量'], ['stock_unit', '单位'],
  ['package_mode', '包装方式'], ['package_contents', '包装内容'], ['included_accessories', '包含配件'], ['gift_contents', '赠品'],
  ['is_accessory', '配件标识'], ['is_consumable', '耗材标识'], ['product_type', '商品类型'], ['package_weight_g', '包装重量（克）'],
  ['length_cm', '长度（厘米）'], ['width_cm', '宽度（厘米）'], ['height_cm', '高度（厘米）'], ['components', '主档组成']
].map(([key, label]) => ({ key, label }));

export const PRODUCT_EDIT_SOURCES = { catalog_edit: '库存资料编辑', core_name_edit: '核心品名修改' };

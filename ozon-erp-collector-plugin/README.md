# 爆单ERP 插件

这是爆单ERP的独立采集插件，可直接在 Chrome 扩展页加载，也可以在 ERP 的扩展管理里选择该目录加载。

插件默认连接线上 ERP：`https://erp.hjt888.xyz`。如果后续公网域名变化，只需要在插件弹窗里修改 `ERP 地址`，不需要再改扩展代码。

详情采集链路会读取 Ozon 前台商品详情、变体、富文本、标签和特征数据，再通过 `seller.ozon.ru` 补充销量、类目和物流字段；写入 ERP 后再打开商品编辑页。

弹窗里的“采集指定 SKU”会逐个打开 Ozon 商品详情页，只生成“已采集商品”列表需要的精简数据，并通过 seller bridge 补充销量、类目、流量、物流等字段；如果没有打开 `seller.ozon.ru`，后台会自动打开 seller 页后再请求补数，最后写入 `/api/local-plugin/collected-products/sync`。

插件不再配置第三方鉴权信息或登录态，也不访问第三方 SKU 接口。打开 Ozon 前台任意页面后，插件会自动扫描当前页面商品 SKU，并查询 ERP 已采集商品状态；如果 ERP 未采集或采集日期不是当天，会直接通过 `seller.ozon.ru` bridge 采集“已采集商品”页面需要的列表数据并写入同一个已采集商品库，不打开 Ozon 商品详情页，也不跳 ERP 编辑页。

## 核心功能

1. Ozon 前台页自动读取当前页 SKU：详情页取 URL 里的商品 SKU，首页、搜索、类目、品牌等页面取商品卡片链接里的 SKU；命中 ERP 当天数据则跳过，缺失或过期则通过 seller bridge 自动采集列表数据并写入已采集商品。
2. 商品详情页植入手动采集按钮；点击后读取当前商品详情、变体、富文本描述，再通过 seller bridge 补充实时字段，并写入 ERP 已采集商品。
3. 在 Ozon 商品卡片下方展示 ERP 状态，默认开启。
4. popup 手动 SKU 入口会自动打开 Ozon 详情页，命中当天缓存则复用，历史日期或未采集则补采。

## 关键源码

- `collector.js`：Ozon 前台商品详情、变体、富文本和 seller 补数字段采集共享内核。
- `content.js`：列表页自动扫描、详情页手动采集按钮、卡片 ERP 状态 UI 注入。
- `seller-bridge-content.js`：运行在 `seller.ozon.ru`，承接 seller 后台登录态、公司 ID 和跨 Tab 请求桥接。
- `background.js`：负责 popup 与当前标签页之间的消息转发、手动 SKU 详情页采集编排、ERP 服务端接口代理，以及 seller 跨 Tab 桥接。
- `popup.html` / `popup.js`：“采集当前页”入口、手动 SKU 采集入口、ERP 地址配置和卡片状态开关。

## 数据口径

展示转化率按以下口径计算：

- `custom_click_rate = 点击率 = 点击量 / 展示量`
- `qtyViewPdp = 商品详情页浏览量 ≈ 点击量`
- `soldCount = 销量 / 订单数`
- `展示量 = qtyViewPdp / custom_click_rate`
- `展示转化率 = soldCount / 展示量`

## 安装

Chrome：

1. 打开 `chrome://extensions`。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择项目根目录下的 `ozon-erp-collector-plugin`。
5. 默认 ERP 地址为 `https://erp.hjt888.xyz`；本地开发可在插件弹窗里改成 `http://127.0.0.1:33334`。

Electron：

1. 打开 ERP 的“扩展管理”。
2. 选择扩展目录 `ozon-erp-collector-plugin` 并加载。
3. 打开采集浏览器中的 Ozon 页面测试。

# Ozon ERP

这是一个本地运行的 Ozon 运营/库存/采购/订单管理项目。

当前项目已经不是单纯的利润计算页，而是一个单机版业务系统，核心围绕这些数据对象展开：

- 店铺
- 人员
- 真实库存产品
- Ozon 在线 SKU
- SKU 绑定关系
- 采购请求与采购单
- 入库与出库流水
- 订单与订单利润
- 库存预警与异常任务

## 真实入口

这几个文件是当前项目最重要的入口：

- 后端入口：[src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
- 前端页面：[public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
- 当前前端主文件：[public/app.repair.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js)

注意：

- `public/app.repair.js` 现在才是实际在用的主前端文件
- `public/app.js` 是较早版本的可运行前端，不再是当前主入口
- `public/app.js.broken-20260512-restore-bak` 是损坏备份，不能直接当主文件使用

## 启动方式

```powershell
npm start
```

或者直接双击：

```text
start.bat
```

默认访问地址：

```text
http://localhost:8787
```

## 当前项目结构

### 前端

- [public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
  页面骨架和各类弹窗容器
- [public/app.repair.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js)
  当前主前端逻辑，包含视图切换、表格渲染、表单提交、登录、利润、库存预警、采购、订单等
- [public/styles.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/styles.css)
  主样式
- [public/design-system.css](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/design-system.css)
  设计系统样式

### 后端

- [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
  原生 Node `http` 服务，负责静态文件和 API 路由
- [src/services.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
  最大的业务实现文件，几乎所有业务 API 最终都落在这里
- [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)
  SQLite 初始化、表结构、密码工具
- [src/profit.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/profit.js)
  利润相关计算
- [src/celRates.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/celRates.js)
  CEL 运费/计价规则
- [src/ozonClient.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/ozonClient.js)
  Ozon 相关接口与同步逻辑

## 主要功能模块

### 1. 选品和库存产品

前端里“选品计价表”和“产品库存表”已经揉合得比较深。

当前支持：

- 创建库存产品
- 编辑库存产品
- 录入采购成本、尺寸、重量、运送方式
- 计算建议售价和利润
- 从在线 SKU 或订单快速创建库存产品

### 2. 在线商品和 SKU 绑定

当前支持：

- 同步在线商品
- 把 Ozon 在线 SKU 绑定到真实库存产品
- 从在线 SKU 直接创建库存产品
- 维护 SKU 负责人

### 3. 采购

当前支持：

- 提交采购请求
- 合并采购请求生成采购单
- 确认采购
- 跟踪入库前状态

### 4. 入库和出库

当前支持：

- 采购完成后进入待入库
- 入库通过后增加库存
- 订单同步后生成出库记录
- 取消、退货、拒收等会影响库存流水

### 5. 订单和利润

当前支持：

- 订单列表
- 店铺/时间/搜索筛选
- 订单 SKU 绑定状态显示
- 订单利润汇总
- 店铺 / SKU / 产品维度利润看板
- 订单利润重算

### 6. 库存预警和异常任务

当前支持：

- 库存预警表
- FBP 库存表
- 仓库识别规则
- 异常任务中心

## 数据位置

项目数据不在前端文件里，主要在 `data/` 下的 SQLite 文件：

```text
data/ozon-profit-hub.sqlite
data/ozon-profit-hub.sqlite-wal
data/ozon-profit-hub.sqlite-shm
```

不要只复制前端文件来迁移项目数据。

## 备份和恢复

备份：

```powershell
.\backup-data.bat
```

或：

```powershell
npm run backup:data
```

恢复：

```powershell
.\restore-data.bat
```

恢复脚本会优先从 `backups/` 目录里找最新备份包。

## 自检脚本

项目现在带了一个最小健康检查脚本，用来快速确认：

- 当前是否存在有效登录 session
- 服务是否可访问
- 关键受保护接口是否能正常返回数据
- 订单 / 在线商品 / 采购 / 利润汇总这些主模块是否至少有结构正确的响应

运行方式：

```powershell
npm run check:health
```

说明：

- 这个脚本会直接读取本地 SQLite 里的最新有效 session，然后带着 Bearer token 请求接口
- 如果本地没有有效登录 session，脚本会直接失败并提示
- 如果某个关键接口返回非 200，脚本会返回非 0 退出码，适合排查“页面没数据”到底是前端还是接口问题

## 当前已知情况

### 1. `app.repair.js` 是主文件

这个已经切换完成，`index.html` 现在加载的是 `app.repair.js`。

### 2. 前端曾经发生过编码损坏

`app.repair.js` 之前不只是中文乱码，还混入了模板字符串损坏、引号缺失、坏掉的 HTML 片段。当前已经修过一轮，至少满足：

- 语法可通过
- 页面主流程能继续修
- 店铺/人员/修改密码/利润规则/物流规则/库存预警等主要区域已恢复大量可读文本

### 3. README 已按当前项目重写

旧 README 是严重乱码版本，已经不适合作为真实说明文档。

## 建议阅读顺序

如果你要继续接手这个项目，建议按这个顺序看：

1. [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js)
2. [src/services.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js)
3. [public/index.html](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/index.html)
4. [public/app.repair.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js)
5. [src/db.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/db.js)

## 下一步建议

接下来优先做这三件事：

1. 继续清理 [public/app.repair.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/public/app.repair.js) 里剩余分散乱码
2. 把 [src/server.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/server.js) 和 [src/services.js](/C:/Users/DIZAI/OneDrive/文档/ozon-erp/ozon-system/src/services.js) 里注释/错误提示中的乱码也修掉
3. 补一份更细的模块文档，分别说明订单、采购、库存预警、利润快照的实际数据流

# 公司月度文件账与凭证归档

入口：财务中心 → 公司账单与凭证，路由 `/finance/company-statements`。支持 `?month=YYYY-MM` 初始月份。

本次从远程 `release/2026.10.21-task-brand` 的 `c6670532090a2285980d9ce42c17b5335592e2a2` 开始开发。没有合并或部署。

## 工作流程

1. 在既有公司设置中维护主体税号及店铺有效期归属。
2. 选择公司、业务月份和店铺，批量选择原始 PDF/XLSX；连连流水选择公司共用。
3. 原件先进入现有企业私有财务附件，解析结果单独保存为待确认。解析、期间或主体异常保存错误说明，不进入汇总。
4. 检查预览并确认归档。只有已确认的人民币业务事实参与本页金额汇总。
5. 在费用明细点击原件，检查平台文件内部控制及收付款候选。会计填写认可、补件、调整意见，保留审核历史。
6. 按公司导出月度、季度或年度草稿 ZIP，含账单、明细、原件、审核历史及缺件。业务原件只导出一次。

## 本次支持并以 Z 店10月原件验收的格式

- 销售报告 XLSX：逐商品行销售、退货及合作伙伴调整，核对净销售控制总额。
- 两期 Status 1 综合服务 PDF：佣金、点击广告、物流连接、货代管理及缔约服务逐项提取，核对文件总额。
- 两期转收费 PDF：收单与国际物流逐项提取并核对合计。
- 星级推广 CNY 服务书：记一笔费用；同号 RUB 发票只补证，不再记费。
- 赔偿 PDF：保留报告业务期间，赔偿作为收入候选，不当成货损费用。
- RUB 相互结算 XLSX：期初、变动及期末余额核对。
- CNY 结算 PDF与全年付款 XLSX：保存结算应付及实际转出，不当成销售收入。
- 连连入账、提现 XLSX：保留 CNH/CNY、原始交易日期及手续费，跨月数据按事件日期筛选。
- 其他业务报表、图片：作为配套档案，不自行增加金额。没有文字的扫描件不做OCR金额入账。

本次不是所有历史 Ozon 文件格式的通用解析器。未支持或结构变化的文件会明确待审，不通过文件名猜金额。

## 对账边界

同额且相近日期的 CNY 平台付款与 CNH 入账只生成候选；多候选保持歧义，不按第一笔自动匹配。收款、提现和手续费分别列示。银行回单未提供时持续显示待补，不把提现表金额当成实际银行到账，也不因原币数值相同认定汇兑为零。

现有 ERP 订单利润和本页文件账分开保存。本页不回写 `profit_order_items`，不改冻结公式，不将平台上传费用再加到已同步利润中。采购、月末库存、工资社保通过既有模块查看，尚不自动形成该导入账簿的成本结转。因此始终标明公司完整利润未核实。

## 安全与一致性

- 所有 API 根据会话重验成员和财务权限；公司、店铺有效期、附件、单据、导出均校验企业归属。默认企业只兼容已有 NULL 归属数据，不扩大到其他企业。
- 原始附件复用私有下载保护；解析器不接受客户端提交的金额。
- 新表 `finance_import_documents` 使用非空企业、公司、店铺键（公司共用为0）。文件 SHA256 及业务编号键均唯一；同业务不同内容报冲突，不自动覆盖历史。
- 确认和审核在事务中锁定既有公司月份记录，关账与写入串行；审核使用版本号避免并发覆盖，并保留经办人、时间和意见。
- XLSX先检查解压总量，读取合法OOXML前缀和缺省行号；拒绝DOCTYPE及外部工作表路径。PDF关闭动态求值。单文件20MB，导出最多500份/200MB。
- ZIP使用安全路径及SHA256校验；导出Excel文本防公式注入。ZIP为草稿，会计认可不等于税务审批。
- 新表在首次使用模块时以 `CREATE TABLE IF NOT EXISTS` 建立。没有修改生产数据库；上线前应按正式发布流程审查该DDL。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/finance-center/voucher-attachments` | 复用私有原件上传 |
| POST | `/api/finance-center/document-import` | action为preview、confirm或review |
| GET | `/api/finance-center/document-report` | company_id及month，或from/to月份范围 |
| GET | `/api/finance-center/document-export` | 相同公司期间范围，生成ZIP |

## 验证

```sh
node --test test/company-finance-documents.test.js test/finance-center-guards.test.js test/tenant-finance-center.test.js test/enterprise-finance-read-gates.test.js
TENANT_TEST_MYSQL_SOCKET=/path/to/independent/mysql.sock node --test test/company-finance-documents.mysql.test.js
npm run check:encoding
node scripts/check-sql-bindings.mjs
npm run build:frontend
```

独立 MySQL 测试先验证服务器禁用 TCP，创建随机测试库，结束只删除该随机库，不使用应用数据库凭据。

`scripts/preview-company-finance.mjs` 是本机专用验收工具。显式传入私有预审清单（files、reviews、raw），在独立随机库导入原件、与独立整理金额比较并实际导出ZIP。监听地址固定127.0.0.1:8788，不用于生产入口，不在仓库保存真实原件。

```sh
TENANT_TEST_MYSQL_SOCKET=/path/to/independent/mysql.sock node scripts/preview-company-finance.mjs /private/path/manifest.json /private/path/results
```

本地查看：`http://localhost:8788/admin.html#/finance/company-statements?month=2026-10`。

另运行 `test/enterprise-finance-authority.test.js` 时，其既有首页权限静态断言仍引用旧的 `hasPermission(authStore.user, "finance")` 文本，和当前基线首页实现不符；该测试及首页均未在本次更改。此项与本次公司文件账测试分开记录。

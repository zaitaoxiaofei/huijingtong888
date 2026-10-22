# 企业一对一私信

私信仅在当前企业的启用真人账号和启用成员之间使用。平台超级管理员必须有当前企业成员关系，且只能查看自己的会话；没有全平台聊天查看入口。每次查询和写入均从数据库重新检查企业状态、订阅和成员，不依赖旧会话中的岗位快照。联系人、历史会话、未读计数、读消息和发送均排除明确标为 `account_kind = 'system'` 的账号，系统账号也不能作为私信操作人；平台权限及业务岗位不用于推断真人/系统身份。

`enterprise_direct_messages` 保存私信。收件箱、双方游标查询及发送重试均有企业前缀索引。发送端为每条草稿生成并保留 `client_message_id`；网络失败后重用相同标识与内容，服务端返回同一消息。相同标识改发其他内容或其他收件人会返回 409。文本限 1 至 4000 字，不解释 HTML，不支持附件、群聊或后台代读。

联系人、会话、对话标题和双方消息显示账号头像；缺图或加载失败显示姓名首字。Enter 发送，Shift + Enter 换行；输入法选词确认、组合输入结束紧接的回车及长按重复键不发送消息。发送中的守卫、失败草稿及重试标识不变。

发送事务按人员 ID 升序直接取得双方的排他锁，查询取得共享锁，保留至事务提交。因此同一会话不会出现高 ID 已提交、低 ID 尚未提交而增量游标永久越过消息的情况，也不通过先共享再升级来制造死锁。新增消息和已读时间显式使用 `UTC_TIMESTAMP(3)`，不依赖数据库会话时区。

接口契约由 `src/server/api-docs.js` 维护，生成到 [后端接口文档](BACKEND_API_REFERENCE.md)。读取最近一页、历史页和增量页都不会自动已读；客户端仅向 `read` 提交确已显示的收到消息 ID，不能用最大 ID 一次标记所有旧消息。使用轻量轮询；响应设置 `Cache-Control: no-store`，前端切换账号或企业时须关闭旧请求并清空会话与草稿视图。

订单引用按订单所属店铺限制企业，默认企业兼容旧 NULL 店铺归属。采购引用对应 `procurement_requests.id`，按需求自身、非空产品归属和来源订单店铺校验企业；产品已删除或移至其他企业时，搜索、发送和历史消息中的引用均不可访问，默认企业的 NULL 兼容不会放开其他企业产品。不把缺少归属的 `purchase_orders` 当作企业采购记录。标签和站内链接由服务端生成，忽略客户端传入的标签及网址。读取消息时重新检查引用权限和归属；无权访问时只显示“记录暂不可访问”。关联卡片显示记录类型、编号和查看入口。采购需求可以通过单条 `reference` 接口读取安全摘要，包括已完成需求，不依赖工作台待处理聚合。“在采购工作台查看”保留 `message_request_id`，工作台再次通过同一权限接口打开指定需求的只读摘要，不修改待采购筛选或恢复已关闭需求。

## 数据库迁移与部署

应用账号不负责建表或修改 schema。先使用有目标数据库配置的工作区只读检查：

```sh
node scripts/migrate-enterprise-messages.mjs
```

应用模式必须显式指定本机管理员 socket；创建私信表和索引，并为 `people` 新增 `account_kind VARCHAR(16)`，默认 `person`，不推断或修改已有账号分类：

```sh
node scripts/migrate-enterprise-messages.mjs --apply --mysql-admin-socket=/var/run/mysqld/mysqld.sock
```

官方 ECS 发布流程已将此脚本加入常规数据库维护清单，在完整数据库备份成功后、候选启动前执行。若显式跳过数据库维护，须先确认表已经迁移；不能依靠应用启动补表。旧版本不使用此表，代码回滚保留已存消息。

迁移会检查 InnoDB、列类型及可空性、重试标识的二进制排序规则，以及索引唯一性和列顺序；同名但不兼容的表或账号分类字段会拒绝应用，不静默修改或覆盖现有数据。未准备账号分类字段时，私信返回可操作的 503 迁移提示，不忽略筛选继续查询。

## 系统账号的明确审查

旧账号及注册账号默认为 `person`。`e2e`、`healthcheck` 等名字只是人工审查线索，不能靠字符串批量修改。历史默认企业成员问题仍按 [平台身份与企业成员迁移](platform-enterprise-identity-migration.md) 处理；账号分类工具不修改成员关系、岗位、平台授权或历史业务引用。明确的系统账号也不出现在企业人员管理及当前企业 `/api/people` 业务选择器中，企业人员修改接口不接受直接指定系统账号。选品、订单、采购等业务页沿用此业务选择器；历史单据引用不变。双身份平台管理员在当前企业同样使用真人列表；平台人员管理可显式请求 `/api/people?scope=platform`，普通成员请求此范围返回 403。该显式范围及无企业上下文的平台专用会话保留原 `services.people()` 的平台管理数据投影，当前仍取默认企业成员，不扩大为任意全局账号；平台 `/api/tenants/members` 保留指定企业的完整成员关系供审查。全局账号分类盘点通过只读审查脚本完成。账号分类不创建其他平台权限。

只读盘点不会创建字段、修改账号或撤销会话；输出人员 ID、分类与启用状态，不输出姓名、登录名或密码：

```sh
node scripts/review-people-account-kinds.mjs
node scripts/review-people-account-kinds.mjs --manifest=/absolute/path/reviewed-account-kinds.json
```

管理员须核对真实人员 ID 及测试/监控账号来源，再填写明确清单。下列 ID 仅为结构示例：

```json
{
  "version": 1,
  "reviewed_by_person_id": 101,
  "reason": "已核对自动化账号来源与用途",
  "accounts": [
    { "person_id": 102, "expected_account_kind": "person", "account_kind": "system" }
  ]
}
```

应用要求本机管理员 socket、清单和有效平台超级管理员审核人。每个人员的当前分类必须匹配 `expected_account_kind`；任何不符都回滚整批。变更写入 `people_account_kind_audit`，并撤销变更账号的旧会话。恢复真人同样使用明确清单，反向设置 `system` → `person`。应用前应按 ECS 流程备份；本功能开发和测试不代表已分类生产中的历史账号。

```sh
node scripts/review-people-account-kinds.mjs --apply --manifest=/absolute/path/reviewed-account-kinds.json --mysql-admin-socket=/var/run/mysqld/mysqld.sock
```

## 隔离验证

`test/enterprise-messages-mysql.test.js` 使用明确的 `TENANT_TEST_MYSQL_SOCKET`，只创建和删除自己随机命名的 `ozon_messages_test_*` 库；不读取应用业务库。覆盖双方及第三方、双企业账号、平台账号、成员停用、账号停用、企业停用、并发重试、游标、显式已读、跨企业及伪造引用、明确系统账号的全链路隔离，并以真实官方脚本验证管理员迁移可重复执行。未指定隔离实例时仅 MySQL 部分跳过，精确路由及授权测试仍运行。`people-account-kind-review.test.js` 验证审查前提和范围，`people-account-kind-mysql.test.js` 使用随机隔离库验证分类、审计、会话撤销与失败回滚；`enterprise-messenger.browser.test.js` 验证真实组件头像、输入法/键盘行为及原有消息重试；`procurement-message-reference.test.js` 验证精确引用加载和账号切换时的过期请求保护。

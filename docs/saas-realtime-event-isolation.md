# 企业实时通知隔离

`subscribeGlobalUpdateEvents(res, query, trustedSession, { authorize })` 在连接建立时只保存认证会话中的人员和企业 ID、企业 slug。查询参数不能选择收件人或企业。

`authorize` 必须通过建立连接时捕获的原登录令牌重新读取当前会话。每次发送业务事件前分别执行，不缓存授权结果。返回的人员、企业 ID 和 slug 必须与原连接相同，且 `tenant.access_allowed === true`；不存在、查验异常、成员或企业失效、订阅过期、退出登录、令牌过期、切换企业时，连接关闭并清除心跳及订阅。缺少该回调的连接不能接收业务数据。不会选择其他管理员身份代替原会话。

`broadcastGlobalEvent` 返回各订阅发送完成的 Promise；现有调用方可以继续异步触发。每个连接按顺序处理事件，逐条检查权限，并在排队时固定本条事件的载荷。等待权限查询期间连接关闭时，丢弃尚未发出的业务数据。已有业务事件的企业和人员匹配规则保持：带数值企业 ID 的事件仅发本企业；没有企业标记的旧事件只兼容默认企业。公共版本公告、连接问候和心跳不含企业业务载荷，仍可跨企业使用。

实际行为测试为 `test/system-event-fresh-authorization.test.js`；`test/tenant-system-events-mysql.test.js` 使用独立 MySQL 随机数据库以及真实 `createSessionMysql/getSessionMysql/switchSessionTenantMysql`，验证 A/B/默认企业投递、七种撤权或会话变化、零私有载荷及切换后新连接边界。测试不写生产库，不代表已经部署。

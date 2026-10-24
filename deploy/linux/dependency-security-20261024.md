# 2026-10-24 依赖安全补丁与验证

本轮只更新开发工作区的清单、锁文件和本机安装依赖，没有部署 ECS、迁移业务数据库或重启服务。`npm audit` 为当日注册表报告，数量会随新公告变化，不能等同于应用漏洞可达性证明。

## 已更新

- MySQL 驱动固定为 `3.23.1`，修复压缩协议解压的资源上限问题，保留 3.x 接口。使用隔离的 socket-only MySQL 验证真实队列饱和、恢复、SQL 错误保留、行锁等待撤权和并发额度。
- Vue 及配套包保持 `3.5`，提升至 `3.5.44`。实际 SSR 属性名注入案例验证不再输出包含回车的危险属性；正常前端构建完成，保留现有界面与业务代码。
- `qs`、`brace-expansion` 各现有主版本、`postcss`、`nanoid`、`source-map-js`、`@xmldom/xmldom`、`form-data`、`tar`、`undici`、`js-yaml` 和 `http-cache-semantics` 仅在现有兼容版本约束内更新。
- ExcelJS `4.4.0`、Sharp `0.35.5`、OSS SDK `6.x` 保持。验证 PNG/JPEG 实际转换、Excel 中文／数量／金额／公式／嵌图往返，以及 OSS 中文对象下载签名；没有调用真实 OSS 或供应商。

按 `npm audit --omit=dev --json`，ECS 安装范围从 6 高、4 中降为 0 高、2 中；含开发／桌面依赖的全量报告从 1 严重、21 高、4 中降为 0 严重、10 高、2 中。这是本地锁文件结果，不能表述为线上依赖已完成更新。

## 未强行升级

剩余运行时两条中等报告是 ExcelJS 及其 `uuid@8.3.2` 的间接告警。维护者公告针对 `v3`、`v5`、`v6` 接受过短外部缓冲区的边界检查；当前 ExcelJS 唯一调用点为条件格式的 `v4()`，没有传入外部缓冲区。未发现这条告警在该调用点直接可达，但依赖仍属于公告版本范围，不能报告为彻底修复。`npm audit fix --force` 提议降级 ExcelJS 至 3.4.0，因此本轮没有使用；跨主版本替换 UUID 或换 Excel 库必须单独验证导入导出兼容性。

剩余开发范围告警涉及 Electron、electron-builder 及打包链、extract-zip、Vite。它们不随 `npm ci --omit=dev` 安装到 ECS；桌面安装包和开发服务器仍需独立升级验收。本轮没有发布新的桌面包，也没有把开发服务器开放给客户。

注册表报告与本机物理文件须同时确认。本次第一次安装因 `node_modules/.package-lock.json` 隐藏缓存误报 up-to-date，实际仍为旧包；仅移除该生成缓存后重新安装，物理包版本和行为测试才与锁文件一致。不能只凭 `npm ls` 或审计锁文件结果判断执行中的版本。

## 官方核查依据

- [mysql2 维护者公告](https://github.com/sidorares/node-mysql2/security/advisories/GHSA-rgwj-5xj2-c3m3)
- [Vue 维护者公告](https://github.com/vuejs/core/security/advisories/GHSA-g2v6-rqmx-r4w6)
- [UUID 维护者公告](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)
- [xmldom 维护者公告](https://github.com/xmldom/xmldom/security/advisories/GHSA-8344-3jmq-59r6)
- [form-data 维护者公告](https://github.com/form-data/form-data/security/advisories/GHSA-hmw2-7cc7-3qxx)

证据位于忽略目录 `.verification/dependency-*-audit-*.json`、`dependency-runtime-compatibility.log`、`dependency-mysql-compatibility.log` 和 `dependency-frontend-build.log`。媒体相关既有回归有一项陈旧源码断言仍要求 AI 原始图片自动公开为 `ai-unused`，而现行为按已验收的私有文件边界保存；该失败未改写测试，不能计入通过数。定向可执行兼容测试与既有结构断言结果分别报告。

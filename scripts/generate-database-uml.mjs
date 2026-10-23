import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline documentation generator. It never connects to a database or app service.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'docs/architecture/erp-data-map');
const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'schema-catalog.json'), 'utf8'));
const review = JSON.parse(fs.readFileSync(path.join(dir, 'relationship-catalog.json'), 'utf8'));
const simplification = JSON.parse(fs.readFileSync(path.join(dir, 'simplification-review.json'), 'utf8'));
const template = fs.readFileSync(path.join(dir, 'viewer-template.html'), 'utf8');
const tables = new Map(catalog.tables.map(t => [t.name, t]));
const domains = catalog.domains;
const relations = review.relations;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
assert(tables.size === catalog.tables.length, 'Duplicate table names');
assert(catalog.tables.every(t => domains.some(d => d.id === t.domain)), 'Unclassified table');
for (const r of relations) {
  for (const side of ['from', 'to']) {
    assert(tables.has(r[side]), `Unknown relation table: ${r[side]}`);
    assert(r[`${side}_columns`].length > 0, `Missing columns: ${r[side]}`);
    for (const c of r[`${side}_columns`]) {
      assert(tables.get(r[side]).columns.some(x => x.name === c), `Unknown column: ${r[side]}.${c}`);
    }
  }
  assert(r.evidence?.length > 0, `Missing evidence: ${r.from} -> ${r.to}`);
}
const physical = relations.filter(r => r.kind === 'foreign-key');
assert(physical.length === catalog.provenance.foreign_key_count, 'Foreign-key coverage differs');
const alias = name => `t_${name}`;
const label = value => String(value).replaceAll('"', "'").replace(/[\r\n]/g, ' ').replaceAll('<', '‹').replaceAll('>', '›');
const columnCount = catalog.tables.reduce((n, t) => n + t.columns.length, 0);
const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(catalog.provenance.snapshot_at));
const header = title => [
  '@startuml', `title ${title}`, 'hide methods', 'hide circle',
  'skinparam linetype ortho', 'skinparam shadowing false', 'skinparam packageStyle rectangle',
  'skinparam defaultFontName Microsoft YaHei', 'skinparam classAttributeIconSize 0',
  'skinparam nodesep 45', 'skinparam ranksep 55',
  `caption 结构基线：${date}（北京时间） / commit ${catalog.provenance.application_commit.slice(0, 7)}。只含结构与源码证据，不代表数据已核平。`,
];
const legend = [
  'legend left', '蓝色实线：数据库声明的外键；绿色虚线：已核查的代码关系。',
  '关系箭头从引用方指向被引用方；代码关系不等于数据库强制约束。',
  '棕色虚线：JSON / 多态 / 兼容转换等条件关系，须阅读 condition。',
  'PK 为主键；UQ 标注索引名，组合唯一键不代表单列唯一；? 表示可空。',
  '未确认的关系留在 relationship-catalog.json 的 unresolved，未画成外键。',
  'tenant_id / shop_id 的存在不是隔离验收结论；目标边界另见 erp-target-boundary.puml。',
  `${review.relation_coverage.tables_with_reviewed_edges} 张表有已核查引用；其余为独立或待确认，不代表可删除或已隔离。`,
  'endlegend',
];
const full = header(`爆单 ERP · 全部 ${catalog.tables.length} 张表 / ${columnCount} 列`);
for (const d of domains) {
  full.push(`package "${label(d.label)}" as d_${d.id} {`);
  for (const t of catalog.tables.filter(t => t.domain === d.id)) {
    full.push(`  class "${t.name}" as ${alias(t.name)} {`);
    for (const c of t.columns) {
      const unique = t.indexes.filter(i => i.unique && i.name !== 'PRIMARY' && i.columns.includes(c.name)).map(i => i.name);
      const tags = [c.primary ? 'PK' : '', ...unique.map(n => `UQ:${n}`), c.nullable ? '?' : ''].filter(Boolean).join(' | ');
      full.push(`    ${label(c.name)} : ${label(c.type)}${tags ? ` [${tags}]` : ''}`);
    }
    full.push('  }');
  }
  full.push('}');
}
for (const r of relations) {
  const color = r.kind === 'foreign-key' ? '#2563EB' : r.condition || r.warning ? '#B45309' : '#15803D';
  const line = r.kind === 'foreign-key' ? `-[#2563EB]->` : `-[#${color.slice(1)},dashed]->`;
  const text = `${r.from_columns.join('+')} → ${r.to_columns.join('+')}${r.condition ? ' [条件]' : ''}`;
  full.push(`${alias(r.from)} ${line} ${alias(r.to)} : ${label(text)}`);
}
full.push(...legend, '@enduml', '');

const grouped = new Map();
for (const r of relations) {
  const from = tables.get(r.from).domain;
  const to = tables.get(r.to).domain;
  if (from === to) continue;
  const key = [from, to].sort().join('|');
  const value = grouped.get(key) ?? { domains: key.split('|'), count: 0 };
  value.count += 1;
  grouped.set(key, value);
}
const overview = header('爆单 ERP · 业务域关系总览（聚合引用，无业务执行方向含义）');
for (const d of domains) {
  const members = catalog.tables.filter(t => t.domain === d.id);
  overview.push(`rectangle "${label(d.label)}\\n${members.length} 张表" as d_${d.id}`);
}
for (const g of grouped.values()) overview.push(`d_${g.domains[0]} -[#64748B]- d_${g.domains[1]} : ${g.count} 条引用`);
overview.push('legend left', '每条连线汇总两个业务域之间已核查的结构 / 代码引用。', '不表示业务执行顺序，不包含仅凭字段名猜测的关系。', '全部表、字段及证据见 erp-database-all.puml 与交互浏览器。', 'endlegend', '@enduml', '');

const target = [
  '@startuml', 'title 企业隔离目标 · 讨论稿（不是当前表结构或已完成验收的声明）',
  'skinparam defaultFontName Microsoft YaHei', 'skinparam shadowing false', 'skinparam packageStyle rectangle',
  'rectangle "全局登录身份\\npeople / 会话" as identity',
  'rectangle "平台授权\\nplatform_grants" as platform',
  'rectangle "平台公共字典\\n品牌 / 车型 / 核心品名" as publicdict',
  'identity --> platform : 独立平台授权',
];
for (const id of ['A', 'B']) {
  target.push(`package "企业 ${id}：严格数据边界" as tenant${id} {`,
    `  rectangle "企业成员 / 角色 / 业务职责" as member${id}`,
    `  rectangle "本企业店铺 1、2…" as shop${id}`,
    `  rectangle "共用库存 / 采购 / 收货 / 台账" as stock${id}`,
    `  rectangle "订单 / 草稿 / 上架 / 财务" as business${id}`,
    `  rectangle "本企业私有字典补充" as dict${id}`,
    `  rectangle "任务 / 文件 / 缓存 / 导出" as async${id}`,
    '}',
    `identity --> member${id} : 有效企业成员关系`,
    `member${id} --> shop${id} : 默认可见本企业全部店铺；操作按岗位授权`,
    `shop${id} --> stock${id} : 同企业共享`,
    `shop${id} --> business${id}`,
    `business${id} --> async${id} : 提交、重试、恢复均带企业身份`,
    `publicdict --> dict${id} : 读公共项 + 本企业补充`,
    `dict${id} --> business${id}`);
}
target.push('note bottom of publicdict', '已确认：公共品牌、车型、核心品名字典 + 企业补充。', '历史商品和单据保留原定义；新建时使用最新公共定义。', '不因字典更新自动重写历史业务记录。', 'AI 案例、提示词、素材是否允许发布为公共内容，尚需另议。', '公共字典不携带客户草稿、图片、库存或成本。', 'end note',
  'note bottom of identity', '平台管理员身份不自动授予企业成员资格。', '企业 A 与 B 的业务数据之间不建立共享引用。', '共享身份、公共字典不等于共享业务记录。', 'end note', '@enduml', '');

const embedded = JSON.stringify({ ...catalog, ...review, simplification, domain_links: [...grouped.values()] }).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
assert(template.includes('/*__DATA__*/null'), 'Viewer data placeholder missing');
const outputs = new Map([
  ['erp-database-all.puml', full.join('\n')],
  ['erp-database-overview.puml', overview.join('\n')],
  ['erp-target-boundary.puml', target.join('\n')],
  ['erp-data-map.html', template.replace('/*__DATA__*/null', embedded)],
]);
for (const [name, content] of outputs) {
  const dest = path.join(dir, name);
  if (process.argv.includes('--check')) assert(fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === content, `Generated file differs: ${name}`);
  else fs.writeFileSync(dest, content, 'utf8');
}
console.log(JSON.stringify({ tables: tables.size, columns: columnCount, foreign_keys: physical.length, code_relations: relations.length - physical.length, domains: domains.length, outputs: [...outputs.keys()], mode: process.argv.includes('--check') ? 'check' : 'write' }));

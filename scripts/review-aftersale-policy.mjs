import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planReviewedAftersaleRepair, applyReviewedAftersaleRepair } from '../src/services/reviewed-aftersale-repair.js';
import { profitCalculationFingerprint } from '../src/services/order-profit-calculation-versions.js';
import { reviewedAftersaleReasons } from '../src/services/reviewed-aftersale-reasons.js';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

export function buildReviewedAftersaleManifest(input) {
  const items = input.rows.map(planReviewedAftersaleRepair);
  return { policy: '2026-10-30', source_captured_at: input.captured_at,
    items, summary: { orders: new Set(items.map(row => row.order_id)).size, items: items.length,
      cancellations: new Set(items.filter(row => row.outcome_type === 'cancelled_pre_fulfillment').map(row => row.order_id)).size,
      cargo_loss: new Set(items.filter(row => row.outcome_type === 'cargo_lost').map(row => row.order_id)).size,
      blocked_items: items.filter(row => row.blocked).length,
      estimated_profit_before: items.filter(row => !row.blocked).reduce((sum, row) => sum + row.before_estimated_profit, 0),
      estimated_profit_after: items.filter(row => !row.blocked).reduce((sum, row) => sum + row.after_estimated_profit, 0) } };
}

async function main() {
  if (!process.argv.includes('--apply')) {
    if (!arg('input') || !arg('output')) throw new Error('只读预览需要 --input=审计快照.json --output=修复清单.json');
    const manifest = buildReviewedAftersaleManifest(JSON.parse(readFileSync(arg('input'), 'utf8')));
    writeFileSync(arg('output'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(JSON.stringify({ mode: 'read_only', summary: manifest.summary, manifest_hash: profitCalculationFingerprint(manifest) }));
    return;
  }
  const manifest = JSON.parse(readFileSync(arg('manifest'), 'utf8'));
  const actorId = Number(arg('actor-id')), commandId = arg('command-id'), reason = arg('reason');
  if (manifest.policy !== '2026-10-30' || !manifest.items?.length || new Set(manifest.items.map(row => row.order_item_id)).size !== manifest.items.length
    || profitCalculationFingerprint(manifest) !== arg('expected-hash')) throw new Error('需使用已审核且哈希一致的修复清单');
  if (!Number.isSafeInteger(actorId) || actorId <= 0 || !commandId || commandId.length > 60 || !reason) throw new Error('需要操作人、命令编号（最多60字符）及修复原因');
  const { mysqlQuery, withMysqlTransaction, closeMysqlPool } = await import('../src/mysql-pool.js');
  try {
    const [admin] = await mysqlQuery("SELECT pg.person_id FROM platform_grants pg JOIN people p ON p.id=pg.person_id AND p.active=1 WHERE pg.person_id=? AND pg.role='super_admin' AND pg.active=1", [actorId]);
    if (!admin) throw new Error('修复操作人必须具有有效的平台超级管理员授权');
    const result = await withMysqlTransaction(async connection => {
      const [currentAdmin] = await connection.query("SELECT pg.person_id FROM platform_grants pg JOIN people p ON p.id=pg.person_id AND p.active=1 WHERE pg.person_id=? AND pg.role='super_admin' AND pg.active=1 FOR SHARE", [actorId]);
      if (!currentAdmin.length) throw new Error('平台管理员授权已变化，停止修复');
      const applied = [], blocked = [];
      for (const item of [...manifest.items].sort((a, b) => a.order_id - b.order_id || a.order_item_id - b.order_item_id)) {
        if (item.blocked) { blocked.push(item.order_item_id); continue; }
        applied.push(await applyReviewedAftersaleRepair(connection, item, { commandId, actorId, reason }));
      }
      // Code-specific rules take priority over historic broad text rules.
      for (const row of reviewedAftersaleReasons) for (const code of row.codes) {
        const text = `reason_id:${code}`;
        const [existing] = await connection.query("SELECT id,reason_code FROM order_cancellation_rules WHERE match_mode='equals' AND BINARY match_text=? FOR UPDATE", [text]);
        if (existing.some(rule => rule.reason_code !== row.reason_code)) throw new Error(`代码 ${code} 已有冲突分类，请先核查`);
        if (!existing.length) await connection.execute(`INSERT INTO order_cancellation_rules
          (name,match_text,match_mode,initiator_label,reason_label,reason_code,reason_group_label,accounting_hint,priority,enabled,note)
          VALUES (?,?,'equals','',?,?,?,?,1,1,?)`, [row.label, text, row.label, row.reason_code,
          row.kind === 'cargo_loss' ? '配送货损/理赔待核' : '取消订单',
          row.kind === 'cargo_loss' ? '商品成本＋收单费，不计佣金及运费；赔付另核销' : '预估履约损失为0；真实扣费另核对',
          `[reviewed-cancellation-reason] policy=2026-10-30; reviewed_by=${actorId}; ${reason}`]);
      }
      return { applied: applied.filter(row => !row.reused).length, reused: applied.filter(row => row.reused).length, blocked };
    });
    console.log(JSON.stringify({ mode: 'applied', ...result, notice: '库存及平台原始状态不变；受影响日期的统计快照需通过既有企业范围刷新流程重建' }));
  } finally { await closeMysqlPool(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

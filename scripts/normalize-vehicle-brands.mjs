// Run from a release with its production environment loaded. Dry-run is the default.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { withMysqlTransaction, closeMysqlPool } from '../src/mysql-pool.js';
import { normalizeVehicleBrand } from '../src/shared/vehicle-brand.js';
const apply = process.argv.includes('--apply');
const backupPath = process.env.BRAND_BACKUP_PATH;
const normalize = value => normalizeVehicleBrand(value, { strict: false });
const counts = {};
try {
  await withMysqlTransaction(async connection => {
    const changes = [];
    async function scan(table, keys, field, transform = normalize, where = '') {
      const [rows] = await connection.query(`SELECT ${[...keys, field].map(c => '`' + c + '`').join(',')} FROM \`${table}\` ${where} FOR UPDATE`);
      for (const row of rows) {
        if (row[field] == null) continue;
        const next = transform(row[field]);
        if (next !== row[field]) changes.push({ table, keys: Object.fromEntries(keys.map(k => [k, row[k]])), before: { [field]: row[field] }, after: { [field]: next } });
      }
    }
    for (const [table, field] of [ ['products','vehicle_brand'], ['listing_drafts','vehicle_brand'], ['asset_variants','vehicle_brand'], ['ai_vehicle_catalog','brand_name'], ['ai_vehicle_brand_assets','brand_name'], ['product_development_ideas','development_brand'] ]) await scan(table, ['id'], field);
    await scan('ozon_plugin_collected_products', ['tenant_id','sku'], 'vehicle_brand');
    await scan('team_tasks', ['id'], 'related_object', value => {
      let parsed; try { parsed = JSON.parse(value); } catch { return value; }
      let changed = false;
      // Only current development scope fields, never text, IDs, images or historical payloads.
      function visit(row) {
        if (!row || typeof row !== 'object') return;
        if (typeof row.brand === 'string') { const next = normalize(row.brand); if (next !== row.brand) { row.brand = next; changed = true; } }
        for (const key of ['models','plans','scopes']) if (Array.isArray(row[key])) row[key].forEach(visit);
        for (const key of ['plan','development_plan']) visit(row[key]);
      }
      visit(parsed);
      return changed ? JSON.stringify(parsed) : value;
    }, "WHERE work_type='product_development'");
    const [options] = await connection.query("SELECT id,value,label,status,usage_count FROM inventory_product_naming_options WHERE option_type='brand' FOR UPDATE");
    const [scopes] = await connection.query("SELECT s.* FROM inventory_product_naming_option_scopes s JOIN inventory_product_naming_options o ON o.id=s.option_id WHERE o.option_type='brand' FOR UPDATE");
    if (scopes.length) throw new Error('Brand option scopes require an explicit reference migration; stopped without changes');
    const groups = new Map();
    for (const row of options) {
      if (row.status === 'archived') continue;
      const brand = normalize(row.value);
      // These historical options contain models, not brands. Preserve their IDs as archived records.
      if (!brand || ['TOYOTA CAMRY','TOYOTA COROLLA','TIGGO 4 NEW'].includes(brand)) {
        changes.push({table:'inventory_product_naming_options',keys:{id:row.id},before:{status:row.status},after:{status:'archived'}}); continue;
      }
      if (!/^[A-Z0-9 &/().+'-]+$/.test(brand)) throw new Error(`Unresolved brand option: ${row.id}`);
      if (!groups.has(brand)) groups.set(brand, []);
      groups.get(brand).push(row);
    }
    for (const [brand, rows] of groups) {
      const keeper = rows.find(row => row.value === brand) || rows.find(row => row.status === 'active') || rows[0];
      const conflictingArchived = options.find(row => row.id !== keeper.id && row.value.toUpperCase() === brand);
      if (conflictingArchived && !rows.includes(conflictingArchived)) throw new Error(`Archived canonical option conflict: ${brand}`);
      const after = {value:brand,label:brand,usage_count:rows.reduce((sum,row)=>sum+Number(row.usage_count),0)};
      if (Object.entries(after).some(([key,value])=>keeper[key]!==value)) changes.push({table:'inventory_product_naming_options',keys:{id:keeper.id},before:Object.fromEntries(Object.keys(after).map(key=>[key,keeper[key]])),after});
      for (const row of rows) if (row.id !== keeper.id) changes.push({table:'inventory_product_naming_options',keys:{id:row.id},before:{status:row.status},after:{status:'archived'}});
    }
    for (const change of changes) counts[change.table] = (counts[change.table] || 0) + 1;
    if (apply && changes.length) {
      if (!backupPath) throw new Error('BRAND_BACKUP_PATH is required for --apply');
      const backup = JSON.stringify({created_at:new Date().toISOString(),changes},null,2);
      fs.writeFileSync(backupPath, backup, {mode:0o600,flag:'wx'});
      fs.writeFileSync(backupPath+'.sha256',crypto.createHash('sha256').update(backup).digest('hex')+'\n',{mode:0o600,flag:'wx'});
      for (const change of changes) {
        const afterKeys = Object.keys(change.after), beforeKeys = Object.keys(change.before), keys = Object.keys(change.keys);
        const [result] = await connection.execute(`UPDATE \`${change.table}\` SET ${afterKeys.map(key=>'`'+key+'`=?').join(',')} WHERE ${keys.map(key=>'`'+key+'`=?').join(' AND ')} AND ${beforeKeys.map(key=>'BINARY `'+key+'` <=> BINARY ?').join(' AND ')}`,[...Object.values(change.after),...Object.values(change.keys),...Object.values(change.before)]);
        if (result.affectedRows !== 1) throw new Error(`Concurrent change detected: ${change.table}`);
      }
    }
    console.log(JSON.stringify({mode:apply?'applied':'dry-run',counts,total:changes.length,backup:apply?backupPath:undefined, mappings:changes.filter(c=>c.before.vehicle_brand).map(c=>[c.before.vehicle_brand,c.after.vehicle_brand]).filter((v,i,a)=>a.findIndex(x=>JSON.stringify(x)===JSON.stringify(v))===i)}));
  });
} finally { await closeMysqlPool(); }

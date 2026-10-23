import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AI_VARIANT_SOURCE_COLUMN_SQL, AI_VARIANT_SOURCE_INDEX_SQL } from '../../src/services/ai-variant-draft-history-schema.js';

export const bindingEnterprises = [{ id: 7, key: 'admin', slug: 'default' }, { id: 2, key: '2', slug: 'binding-a' }, { id: 3, key: '3', slug: 'binding-b' }];
export const bindingPersonId = (tenant, offset = 1) => tenant.id * 100 + offset;
export const bindingSession = tenant => ({ personId: bindingPersonId(tenant), roles: ['operations'], tenant: { id: tenant.id, slug: tenant.slug } });

export async function seedDraftBindingsReadFixture(fixture, passwordHash = '') {
  const q = fixture.query;
  const source = readFileSync(new URL('../../src/services/listing-automation.js', import.meta.url), 'utf8');
  for (const table of ['listing_drafts', 'listing_category_templates', 'listing_shop_copies', 'listing_publish_records']) {
    const sql = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`))?.[0];
    assert.ok(sql, `Actual runtime schema missing: ${table}`);
    await q(sql.replaceAll('${AI_VARIANT_SOURCE_COLUMN_SQL}', AI_VARIANT_SOURCE_COLUMN_SQL).replaceAll('${AI_VARIANT_SOURCE_INDEX_SQL}', AI_VARIANT_SOURCE_INDEX_SQL));
  }
  const bindings = readFileSync(new URL('../../src/services/listing-draft-bindings.js', import.meta.url), 'utf8');
  for (const table of ['listing_draft_bindings', 'listing_draft_vehicle_links']) {
    const sql = bindings.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`))?.[0];
    assert.ok(sql, `Actual binding schema missing: ${table}`); await q(sql);
  }
  for (const tenant of bindingEnterprises) {
    await q('INSERT INTO tenants(id,slug,name) VALUES(?,?,?)', [tenant.id, tenant.slug, `Binding fixture ${tenant.id}`]);
    for (const offset of [1, 2, 3]) {
      const person = bindingPersonId(tenant, offset);
      await q("INSERT INTO people(id,name,username,password_hash,role,avatar_url) VALUES(?,?,?,?,'operations',?)", [person, `Owner ${tenant.id}/${offset}`, `binding${person}`, passwordHash, `https://example.invalid/private-owner-${tenant.id}-${offset}.png`]);
      await q("INSERT INTO tenant_members(tenant_id,person_id,role,business_roles_json) VALUES(?,?,'member',JSON_ARRAY('operations'))", [tenant.id, person]);
    }
    await q('INSERT INTO shops(id,tenant_id,name) VALUES(?,?,?)', [tenant.id * 10, tenant.slug === 'default' ? null : tenant.id, `Binding shop ${tenant.id}`]);
  }
  const records = new Map();
  for (const tenant of bindingEnterprises) {
    const entries = [];
    for (const [index, kind] of ['direct', 'model', 'unallocated', 'idea'].entries()) {
      const draft = tenant.id * 1000 + index + 1;
      const task = tenant.id * 1000 + index + 101;
      await q("INSERT INTO listing_drafts(id,tenant_id,product_name,source_urls_json,source_images_json,manual_facts_json,ai_payload_json) VALUES(?,?,?,'[]','[]','{}','{}')", [draft, index === 0 && tenant.slug === 'default' ? null : tenant.key, `Owned draft ${tenant.id}/${kind}`]);
      const related = kind === 'model' ? { kind: 'development_matrix', category: 'Own category', models: [{ draft_ids: [draft] }] }
        : kind === 'unallocated' ? { kind: 'development_matrix', category: 'Own category', unallocated_draft_ids: [draft] }
        : kind === 'idea' ? { kind: 'development_matrix', category: 'Own category', idea_id: task } : {};
      await q("INSERT INTO team_tasks(id,tenant_id,title,owner_person_id,work_type,related_object) VALUES(?,?,?,?,'product_development',?)", [task, tenant.key, `Owned task ${tenant.id}/${kind}`, bindingPersonId(tenant, 2), JSON.stringify(related)]);
      if (kind === 'idea') await q('INSERT INTO product_development_idea_drafts(tenant_id,idea_id,draft_id) VALUES(?,?,?)', [tenant.key, task, draft]);
      entries.push({ draft, task, kind });
    }
    records.set(tenant.key, entries);
  }
  return records;
}
